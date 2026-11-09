# Bundled browser dependencies

These assets are served from the same Site. Document bytes are processed in the visitor's browser; no runtime CDN request is required.

- PDF.js / pdfjs-dist **4.10.38**: npm `pdfjs-dist-4.10.38.tgz`; Mozilla PDF text extraction and rendering; Apache-2.0. Includes worker, packed CMaps and standard fonts with their licenses.
- Tesseract.js **6.0.1**: npm `tesseract.js-6.0.1.tgz`; Apache-2.0; ESM browser bundle and worker.
- tesseract.js-core **6.0.0**: npm `tesseract.js-core-6.0.0.tgz`; Apache-2.0; LSTM WASM JS bundles (SIMD and non-SIMD fallback).
- `@tesseract.js-data/eng` and `@tesseract.js-data/chi_sim` **1.0.0**: npm language packages, `4.0.0_best_int` models. npm packages declare MIT; upstream traineddata from https://github.com/tesseract-ocr/tessdata_best uses Apache-2.0.

OCR is explicitly selected by the visitor, uses English and Simplified Chinese models, and returns unreviewed text. Engineering symbols are not guaranteed. Input: <=200 MiB per file. PDF: <=500 pages processed sequentially, each with a low-resolution thumbnail and difference hash. Automatic OCR only runs on pages without text when autoOCR:true is selected, with no 10-page ceiling. Explicit whole-PDF OCR for more than 10 pages requires an explicit page selection (for example 1,3-5); selections may cover the entire allowed document. Images: <=60 MP, resized to <=3000 px edge for OCR; image OCR runs by default unless autoOCR:false. AbortSignal cancellation is supported. Visual similarity uses per-page difference hashes, not engineering semantic embeddings. PDF text regions come from text-item transforms and font metrics; OCR regions come from detected line boxes. Page types are coarse text heuristics.

Orientation: `rotation` accepts clockwise 0/90/180/270 degrees. Explicit image rotation suppresses automatic orientation selection. When image OCR confidence is below 55 and no angle was specified, four <=1000px orientation probes compare Tesseract's reported confidence, then a winning nonzero angle is recognized at processing resolution. This is a heuristic; selected angle and measured OCR confidence are included in warnings/page metadata. PDF rotation only applies to pages processed with OCR. Thumbnails, hashes, dimensions and evidence regions follow the chosen orientation.
