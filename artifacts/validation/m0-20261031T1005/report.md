# M0 validation report — m0-20261031T1005

**status: fail**

generated: 2026-11-02T04:33:19+00:00 · wall time: 37s

> `not_run` means the automated part produced evidence but a required gate (manual page/semantic review) has not been completed. It is not a pass.

## Environment

- captured_at: `2026-11-02T04:32:43+00:00`
- moonlight_version: `0.1.0`
- platform: `Linux-6.8.0-101-generic-x86_64-with-glibc2.39`
- machine: `x86_64`
- cpu_model: `AMD Ryzen 7 6800H with Radeon Graphics`
- cpu_count: `16`
- memory_bytes: `32299491328`
- python: `3.11.15`
- python_executable: `/home/bynshard/paperReader/.venv/bin/python`
- pymupdf: `2.0`
- node: `v18.19.1`
- credentials: `configured_via_gateway_env (value not recorded)`
- screen_scale: `not_applicable (off-screen rendering)`
- timezone: `UTC`
- engine: `{"babeldoc": "0.6.2", "babeldoc_cli": "babeldoc 0.6.2", "pymupdf": "2.0", "python": "3.11.15", "executable": "/home/bynshard/paperReader/.venv/bin/babeldoc"}`
- model: `{"id": "qwen3.8-flash", "provider": "openai-compatible", "endpoint_host": "opencode.ai", "temperature": "engine default (not overridden)", "prompt": "babeldoc builtin prompt v0.6.2"}`

## Gates

| gate | status | target | value |
| --- | --- | --- | --- |
| document_geometry | pass | page count, page size and rotation identical |  |
| translation_coverage | pass | overall >= 0.95, every page >= 0.9 | 0.9902 |
| paragraph_start_offset | fail | >= 0.95 of translated blocks within 3% of page size | 0.9259 |
| font_readability | fail | translated body text >= 8pt and >= 75% of source size | 0.9877 |
| fallback_transparency | pass | every retained/failed region carries a reason |  |
| edge_cases | pass | broken/encrypted inputs rejected explicitly; scanned page not counted as translated |  |
| page_range_mapping | pass | range output keeps 1:1 page numbering; only requested pages translated |  |
| formula_numeric | not_run | manual: >=30 key formulas/numbers checked |  |
| semantic | not_run | manual: >=50 review segments, >=90% correct, 0 critical errors |  |
| severe_layout | not_run | manual page inspection: no unannounced clipping/overlap/column bleed |  |

## Samples

| sample | pages | required blocks | translated | coverage | output |
| --- | --- | --- | --- | --- | --- |
| arxiv-1706.03762 | [1, 2, 3, 4, 7, 11] | 51 | 50 | 0.9804 | attn.no_watermark.zh-CN.mono.pdf |
| arxiv-2409.19256 | [1, 2, 3, 5, 8, 18] | 81 | 81 | 1.0 | hybridflow.no_watermark.zh-CN.mono.pdf |

## Per-page coverage

### arxiv-1706.03762

| page | required | translated | retained | failed | coverage |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 | 4 | 0 | 0 | 1.0 |
| 2 | 12 | 12 | 0 | 0 | 1.0 |
| 3 | 7 | 7 | 0 | 0 | 1.0 |
| 4 | 14 | 13 | 0 | 1 | 0.9286 |
| 7 | 14 | 14 | 0 | 0 | 1.0 |
| 11 | 0 | 0 | 0 | 0 | None |

### arxiv-2409.19256

| page | required | translated | retained | failed | coverage |
| --- | --- | --- | --- | --- | --- |
| 1 | 8 | 8 | 0 | 0 | 1.0 |
| 2 | 7 | 7 | 0 | 0 | 1.0 |
| 3 | 33 | 33 | 0 | 0 | 1.0 |
| 5 | 14 | 14 | 0 | 0 | 1.0 |
| 8 | 12 | 12 | 0 | 0 | 1.0 |
| 18 | 7 | 7 | 0 | 0 | 1.0 |

## Boundary samples

| id | status | reason | geometry | cjk | overflow |
| --- | --- | --- | --- | --- | --- |
| corrupt | rejected | truncated or malformed PDF (missing %PDF header or %%EOF trailer) |  |  | / |
| encrypted | rejected | password protected; reader must ask for a password, translation is refused |  |  | / |
| narrow-column | completed |  | True | 170 | 0/0 |
| rotated-cropbox | completed_with_fallbacks | text left the page/column; inspect rendering and manifest | True | 82 | 3/0 |
| scanned-page | unsupported | scanned page skipped by engine |  |  | / |

## Page-range mapping

| probe | requested | output pages | detected translated pages |
| --- | --- | --- | --- |
| middle-page | [5] | 15 | [5] |
| non-contiguous | [3, 9] | 15 | [3, 9] |
| first-page | [1] | 15 | [1] |

## Commands

```bash
/home/bynshard/paperReader/.venv/bin/babeldoc --files corpus/raw/attn.pdf --lang-in en --lang-out zh-CN --openai --openai-model qwen3.8-flash --openai-base-url http://127.0.0.1:<port>/v1 --openai-api-key <gateway-token> --openai-reasoning none --openai-term-extraction-reasoning none --no-dual --watermark-output-mode no_watermark --qps 4 --output artifacts/validation/m0-20261031T1005/outputs/arxiv-1706.03762 --report-interval 10
/home/bynshard/paperReader/.venv/bin/babeldoc --files corpus/raw/hybridflow.pdf --lang-in en --lang-out zh-CN --openai --openai-model qwen3.8-flash --openai-base-url http://127.0.0.1:<port>/v1 --openai-api-key <gateway-token> --openai-reasoning none --openai-term-extraction-reasoning none --no-dual --watermark-output-mode no_watermark --qps 4 --output artifacts/validation/m0-20261031T1005/outputs/arxiv-2409.19256 --report-interval 10
python -m moonlight run-m0 --corpus corpus/corpus.json --out artifacts/validation (edge suite)
python -m moonlight translate --pdf corpus/raw/attn.pdf --pages 5|3,9|1 --out <range-probe>
```

## Not run / next steps

- 人工版面与语义审查（50 段、30 项公式/数值、12 页截图）尚未完成，review.csv 中留空列待填。
- 句级映射、阅读器 GUI、桌面底座构建属于 M1/M2，不在本报告范围。
- 成本：服务端未返回账单，仅记录请求数与 token（见 gateway-usage.jsonl）。
