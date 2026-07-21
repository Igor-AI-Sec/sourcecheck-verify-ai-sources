# Raw test data

Data behind the write-ups. Six models (Claude Sonnet 5 & Haiku 4.5, Gemini Pro & Flash-Lite, ChatGPT standard & mini), three languages (Polish, English, German — German added for the second article), five prompt topics.

- `sourcecheck-test-data-EN.xlsx` — all Polish/English tests, with a "Clean counts" sheet showing raw-vs-hand-counted figures and a separate sheet for the ChatGPT runs that searched the web.
- `test-results-appendix-EN.docx` — human-readable summary of every Polish/English test.
- `claude.docx`, `gemini.docx`, `chat_gpt.docx` — raw exports of the full Polish/English model responses. Headers are in English; the model answers themselves are left untouched, including the Polish ones, because Polish was part of what was tested.
- `chat_gpt_mini_offline.docx` — a follow-up, controlled run of ChatGPT mini with internet access disabled in settings, done after the main run (`chat_gpt.docx`) showed it was quietly browsing despite the "don't search" instruction. With browsing off, its links started failing like every other model's — confirming the write-up's claim that the main run was contaminated by live search. These numbers are what went into the refusal-count comparison in the write-up (shown there as an image, not text — hence not independently verifiable from this repo alone).
- `claude_de.docx`, `gemini_de.docx`, `chat_gpt_de.docx` — the same test, in German, for the second article. Two of the five topics have German-native sources (GDPR court rulings, and part of the market-research topic), testing whether asking in the source language changes the hallucination rate.
- `chat_gpt_mini_offline_de.docx` — the same internet-disabled control run as above, repeated in German.

Note on counting: dead-rate percentages in the second article are hand-counted per model, not taken from the plugin's raw counter (same reasoning as the "Known limitation" section in the main README). The denominator is links from responses where the model actually attempted to answer with links — refusals contribute nothing to either side of the fraction. Some German-language Gemini responses wrap the real URL inside a `google.com/search?q=...` redirect; those are treated as evidence of live searching, not memory, and are excluded from the "clean" dead-rate comparison.

Note: link counts in the spreadsheet are as reported by the plugin, which sometimes split URLs on list numbers/icons. Aggregate percentages in the write-up were recounted by hand to remove those artifacts. See the main README's "Known limitation" section.
