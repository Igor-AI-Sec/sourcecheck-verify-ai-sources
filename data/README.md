# Raw test data

Data behind the write-up. Six models (Claude Sonnet 5 & Haiku 4.5, Gemini Pro & Flash-Lite, ChatGPT standard & mini), two languages (Polish & English), five prompt topics.

- `sourcecheck-test-data-EN.xlsx` — all tests, with a "Clean counts" sheet showing raw-vs-hand-counted figures and a separate sheet for the ChatGPT runs that searched the web.
- `test-results-appendix-EN.docx` — human-readable summary of every test.
- `claude.docx`, `gemini.docx`, `chat_gpt.docx` — raw exports of the full model responses. Headers are in English; the model answers themselves are left untouched, including the Polish ones, because Polish was part of what was tested.
- `chat_gpt_mini_offline.docx` — a follow-up, controlled run of ChatGPT mini with internet access disabled in settings, done after the main run (`chat_gpt.docx`) showed it was quietly browsing despite the "don't search" instruction. With browsing off, its links started failing like every other model's — confirming the write-up's claim that the main run was contaminated by live search. These numbers are what went into the refusal-count comparison in the write-up (shown there as an image, not text — hence not independently verifiable from this repo alone).

Note: link counts in the spreadsheet are as reported by the plugin, which sometimes split URLs on list numbers/icons. Aggregate percentages in the write-up were recounted by hand to remove those artifacts. See the main README's "Known limitation" section.
