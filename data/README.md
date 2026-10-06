# Raw test data

Data behind the write-ups. Six models (Claude Sonnet 5 and Haiku 4.5, Gemini Pro and Flash-Lite, ChatGPT standard and mini), three languages (Polish, English, German; German was added for the second article) and five prompt topics. One trial per model, language and topic. Everything here was collected with plugin v0.6, before the extractor and status changes in 0.7.0.

## Files

- `sourcecheck-test-data-EN.xlsx`: all Polish and English tests. The sheets are: `SourceCheck Tests` (raw plugin counts per model, language and topic), `Summary` (totals computed from the raw sheet), `GPT with-internet runs` (the ChatGPT mini runs that searched the web), and `Clean counts (deduped)`.
- `test-results-appendix-EN.docx`: readable summary of every Polish and English test, with the same raw counts.
- `claude.docx`, `gemini.docx`, `chat_gpt.docx`: exports of the full Polish and English model responses. Headers are in English. The model answers are left untouched, including the Polish ones, because Polish was part of what was tested.
- `chat_gpt_mini_offline.docx`: a follow-up run of ChatGPT mini with internet access disabled in settings, done after the main run (`chat_gpt.docx`) showed it browsing despite the "don't search" instruction. With browsing off, its links started failing like those of the other models. These numbers fed the refusal-count comparison in the write-up, which shows it as an image, so that comparison cannot be checked from this repository alone.
- `claude_de.docx`, `gemini_de.docx`, `chat_gpt_de.docx`: the same test in German, for the second article. Two of the five topics have German-native sources (GDPR court rulings, and part of the market-research topic), testing whether asking in the source language changes the hallucination rate.
- `chat_gpt_mini_offline_de.docx`: the internet-disabled control run, repeated in German.

## Plugin version

All of the data here comes from plugin v0.6. Version 0.7.0 changed how the extension behaves today; it did not rewrite any historical raw data. The v0.6 behaviours that matter for reading the raw counters:

- A generic network error was labelled dead, whatever the cause (DNS, TLS, reset, offline).
- Many non-OK statuses were labelled dead: every non-2xx status other than 401, 403, 429 and 503 counted as dead, so 400, 405, 451, 500, 502 and 504 were dead, as well as 404 and 410.
- One keyword hit was enough to count as OK.
- The words of the link's own URL path could count as matching evidence.
- Non-HTML targets such as PDFs were labelled OK without any content check.
- The extractor could split one URL in two (see the main README), and it skipped every link to `google.com`, `openai.com` and `anthropic.com`.

In 0.7.0 only HTTP 404 and 410 are dead, network failures and non-HTML targets are Unverifiable, one keyword hit is not enough, and the URL path is not evidence. See the main README for the current rules.

## Three kinds of numbers

**A. Raw plugin counters, preserved.** The `SourceCheck Tests` sheet and the appendix hold the counts exactly as plugin v0.6 reported them. They include the split-URL artifacts described in the main README. The totals on the `Summary` sheet are sums of these raw rows (for Claude and Gemini: Anthropic 18 links and 3 dead, Google 77 and 25).

**B. Hand-corrected article counts.** The aggregate percentages in the articles (for example Gemini dead rate Polish about 32% against English about 20%, versus raw 45% and 24%) were recounted by hand from the models' answers to remove the extraction artifacts. The `Clean counts (deduped)` sheet records only these rounded percentages.

**C. What was not kept.** The per-link record of which URLs were discarded, merged or recounted was not retained. The hand-corrected aggregates therefore cannot be reconstructed exactly from this repository. The raw exports and the raw counts let you check the raw numbers and recount for yourself, but a recount may differ from the published figures. No adjudication log has been added after the fact.

## Refusals and what was counted

The `Response` column labels each row Yes, Partial or Refusal. The earlier wording of this file said refusals contribute nothing to the dead-rate denominator. That is not true of the raw sheet: two rows labelled Refusal contain links, and those links are inside the raw totals.

- Gemini Flash-Lite, Polish, e-commerce topic: 1 link
- Gemini Flash-Lite, English, e-commerce topic: 3 links (the note says they were links to homepages)

Those 4 links are part of the 77 Google links on the `Summary` sheet. Whether the hand-corrected article percentages kept or dropped them is not recorded. All other Refusal rows have 0 links.

## Reading the "dead" column

A raw "dead" classification is not a ground-truth hallucination label. Plugin v0.6 reported every network error as dead, and a link could also be counted dead because of a transient failure or a split URL. One example: the `www.tensorflow.org` Keras `Model` link in `screenshots/demo.png` was reported as a network error, and a later manual request to the same URL returned HTTP 200. The notes of several ML-documentation cells (Sonnet 5 English, Haiku 4.5 Polish and English) attribute a dead link to TensorFlow, so some raw dead counts may reflect plugin or network behaviour and not a made-up link. Version 0.7.0 no longer calls network failures dead; the historical data was not changed.

## Other notes

- Dead-rate percentages in the second article are hand-counted per model, not taken from the plugin's raw counter.
- The article denominator is links from responses where the model attempted to answer with links. Refusals were meant to be left out; see the refusal section above for what the raw sheet actually contains.
- Some German-language Gemini responses wrap the real URL inside a `google.com/search?q=...` redirect. Those were treated as evidence of live searching, not memory, and excluded from the "clean" dead-rate comparison. Extractor versions before 0.7.0 skipped every `google.com` link, which is consistent with that handling, but the exclusion itself was done by hand.
- Link counts in the spreadsheet are as the plugin reported them and sometimes split URLs on list numbers or icons.
- Each cell is a single trial, and some cells have 5 to 7 links. The figures are directional, not statistically powered.
