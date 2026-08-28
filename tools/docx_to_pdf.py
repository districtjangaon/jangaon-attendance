# -*- coding: utf-8 -*-
"""Export the Word report to PDF through Word itself, so the table of contents,
the page numbering and the figure layout are exactly what an officer opening
the DOCX would see.

    python tools/docx_to_pdf.py
"""
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'report', 'Sisu_Mahila_Samridhi_District_Report_v1.0.docx')
DST = SRC[:-5] + '.pdf'

if not os.path.exists(SRC):
    sys.exit('build the DOCX first: python tools/build_docx.py')

try:
    import win32com.client as win32
except ImportError:
    from docx2pdf import convert
    convert(SRC, DST)
    print('PDF  ' + DST)
    sys.exit(0)

# Driving Word directly lets the field codes be updated before export, which
# is what fills in the table of contents and the page numbers. docx2pdf alone
# exports the document as saved, leaving the contents page blank.
word = win32.DispatchEx('Word.Application')
word.Visible = False
try:
    doc = word.Documents.Open(SRC, ReadOnly=False)
    for i in range(1, doc.TablesOfContents.Count + 1):
        doc.TablesOfContents(i).Update()
    doc.Fields.Update()
    doc.Repaginate()
    pages = doc.ComputeStatistics(2)   # wdStatisticPages
    doc.SaveAs(SRC)                    # keep the populated contents in the DOCX too
    doc.SaveAs(DST, FileFormat=17)     # wdFormatPDF
    doc.Close(False)
    print('PDF  %s' % DST)
    print('     %d pages' % pages)
finally:
    word.Quit()
