"""
extract_ncert.py
Converts an NCERT .docx chapter into a structured, self-contained JSON file
(ncert_data.json) that logic.js can load and search entirely client-side.

Usage:
    python3 extract_ncert.py kech101.docx ncert_data.json

No external services are used — only python-docx, run once at build time.
"""
import sys, json, re
import docx
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

HEADING_LEVELS = {
    'Title': 0, 'Heading 1': 1, 'Heading 2': 1, 'Heading 3': 1,
    'Heading 4': 2, 'Heading 5': 3, 'Heading 6': 4,
}
# Heading 4 = top-level chapter section, Heading 5/6 = sub-topic.
# Heading 1-3 in this NCERT export are mostly worked-example / equation
# fragments (noisy OCR of Word equation objects) so we keep them attached
# to the running text rather than treating them as searchable topics.
TOPIC_LEVELS = {'Title', 'Heading 4', 'Heading 5', 'Heading 6'}


def iter_block_items(parent):
    """Yield paragraphs and tables in the order they appear in the document."""
    body = parent.element.body
    for child in body.iterchildren():
        if child.tag == qn('w:p'):
            yield Paragraph(child, parent)
        elif child.tag == qn('w:tbl'):
            yield Table(child, parent)


def clean(text):
    text = text.replace('\u2013', '-').replace('\u2014', '-')
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def split_sentences(text):
    # lightweight sentence splitter tuned for chemistry prose
    # (avoids breaking on "e.g." "Fig." "u." units, decimals like 1.008)
    text = re.sub(r'\b(e\.g|i\.e|etc|Fig|No|approx|Ex)\.\s', r'\1<DOT> ', text)
    text = re.sub(r'(?<=\d)\.(?=\d)', '<DOT>', text)  # decimals
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z(])', text)
    return [p.replace('<DOT>', '.').strip() for p in parts if p.strip()]


def main(src, dst):
    d = docx.Document(src)
    chapter_title = 'Chapter'
    sections = []            # [{path:[...], level, paragraphs:[...], tables:[...]}]
    current = {'path': ['Introduction'], 'level': 2, 'paragraphs': [], 'tables': []}
    sections.append(current)
    path_stack = ['Introduction']
    in_worked_example = False  # True while inside a "Solution"/"Example" block

    for block in iter_block_items(d):
        if isinstance(block, Paragraph):
            style = block.style.name
            text = clean(block.text)
            if not text:
                continue
            # worked-example / solved-problem blocks (Heading 1-3 in this export)
            # are equations and arithmetic, not conceptual prose — exclude them
            # from the searchable index so they don't pollute definitions.
            if style in ('Heading 1',) and text.lower() in ('solution', 'example'):
                in_worked_example = True
                continue
            if style in TOPIC_LEVELS and len(text) < 120:
                in_worked_example = False
                if style == 'Title':
                    chapter_title = text
                    path_stack = [text]
                    continue
                lvl = HEADING_LEVELS[style]
                # trim stack to this level, then push
                path_stack = path_stack[:1] if lvl <= 2 else path_stack[:2]
                if lvl == 2:
                    path_stack = [chapter_title, text]
                else:
                    if len(path_stack) < 2:
                        path_stack = [chapter_title, 'General']
                    path_stack = path_stack[:2] + [text]
                current = {'path': list(path_stack), 'level': lvl, 'paragraphs': [], 'tables': []}
                sections.append(current)
            elif not in_worked_example and style not in ('Heading 1', 'Heading 2', 'Heading 3'):
                current['paragraphs'].append(text)
        elif isinstance(block, Table):
            rows = []
            for row in block.rows:
                cells = [clean(c.text) for c in row.cells]
                # de-duplicate merged cells (python-docx repeats merged cell text)
                dedup = []
                prev = object()
                for c in cells:
                    dedup.append(c)
                rows.append(cells)
            if rows:
                current['tables'].append({'rows': rows})

    # drop empty sections
    sections = [s for s in sections if s['paragraphs'] or s['tables']]

    # build flat sentence index for retrieval
    sentence_id = 0
    sentences = []
    for s_idx, sec in enumerate(sections):
        heading = sec['path'][-1]
        for p_idx, para in enumerate(sec['paragraphs']):
            for sent in split_sentences(para):
                if len(sent) < 3:
                    continue
                sentences.append({
                    'id': sentence_id,
                    'section': s_idx,
                    'para': p_idx,
                    'text': sent,
                    'heading': heading,
                    'path': sec['path'],
                })
                sentence_id += 1

    out = {
        'chapter': chapter_title,
        'sections': [
            {'path': s['path'], 'level': s['level'], 'paragraphs': s['paragraphs'], 'tables': s['tables']}
            for s in sections
        ],
        'sentences': sentences,
    }
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    print(f'Wrote {dst}: {len(sections)} sections, {len(sentences)} sentences')


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'kech101.docx'
    dst = sys.argv[2] if len(sys.argv) > 2 else 'ncert_data.json'
    main(src, dst)
