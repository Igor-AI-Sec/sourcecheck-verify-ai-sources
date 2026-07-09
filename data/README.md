# Raw test data

Data behind the write-up. Six models (Claude Sonnet 5 & Haiku 4.5, Gemini Pro & Flash-Lite, ChatGPT standard & mini), two languages (Polish & English), five prompt topics.

- `sourcecheck-test-data-EN.xlsx` — all tests, with a "Clean counts" sheet showing raw-vs-hand-counted figures and a separate sheet for the ChatGPT runs that searched the web.
- `test-results-appendix-EN.docx` — human-readable summary of every test.
- `claude.docx`, `gemini.docx`, `chat_gpt.docx` — raw exports of the full model responses. Headers are in English; the model answers themselves are left untouched, including the Polish ones, because Polish was part of what was tested.

Note: link counts in the spreadsheet are as reported by the plugin, which sometimes split URLs on list numbers/icons. Aggregate percentages in the write-up were recounted by hand to remove those artifacts. See the main README's "Known limitation" section.
