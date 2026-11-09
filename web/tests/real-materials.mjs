/** Read-only corpus audit. No original drawing text or binary is written. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { parseDocument } from '../engine.mjs';
import { readPDFText } from '../ingest.mjs';

const root = process.argv[2];
if (!root) throw new Error('Usage: node tests/real-materials.mjs /absolute/path/to/drawings [report.json]');
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
async function walk(dir, relative='') {
  const files=[];
  for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
    const rel=path.join(relative,entry.name);
    if(entry.isDirectory()) files.push(...await walk(path.join(dir,entry.name),rel));
    else if(entry.isFile() && /\.pdf$/i.test(entry.name)) files.push(rel);
  }
  return files;
}
const names = (await walk(root)).sort();
assert.ok(names.length, 'Corpus contains PDF documents');
const result = {pdfFiles:names.length, read:0, failed:0, pages:0, filesWithText:0, filesWithoutText:0, filesWithCandidates:0, candidateFields:0, candidateBOMRows:0, failedFiles:[], filesWithoutTextNames:[], above30MB:0, above30Pages:0, above500Pages:0, largestFiles:[]};
for (const name of names) {
  let task;
  try {
    const stat=await fs.stat(path.join(root,name));
    if(stat.size>30*1024*1024) result.above30MB++;
    result.largestFiles.push({name,bytes:stat.size});
    task = pdfjs.getDocument({
      data:new Uint8Array(await fs.readFile(path.join(root,name))),
      cMapUrl:new URL('../vendor/pdfjs/cmaps/',import.meta.url).pathname,
      cMapPacked:true,
      standardFontDataUrl:new URL('../vendor/pdfjs/standard_fonts/',import.meta.url).pathname,
      verbosity:0,
    });
    const pdf=await task.promise;
    if(pdf.numPages>30) result.above30Pages++;
    if(pdf.numPages>500) result.above500Pages++;
    const pages=[];
    for(let i=1;i<=pdf.numPages;i++){
      const page=await pdf.getPage(i), extracted=await readPDFText(page);
      pages.push({page:i,text:extracted.text,regions:extracted.regions,method:'pdf-text'});
      page.cleanup();
    }
    const parsed=parseDocument(pages);
    assert.ok(Array.isArray(parsed.fields)); assert.ok(Array.isArray(parsed.bom));
    for(const field of parsed.fields){
      assert.ok(Number.isInteger(field.page) && field.page>=1 && field.page<=pages.length, 'Evidence page is in document');
      assert.ok(field.evidence && typeof field.evidence==='string', 'Candidate includes textual evidence');
    }
    result.read++; result.pages+=pages.length;
    const withText=pages.some(p=>p.text.trim().length);
    if(withText) result.filesWithText++; else {result.filesWithoutText++;result.filesWithoutTextNames.push(name);}
    if(parsed.fields.length || parsed.bom.length) result.filesWithCandidates++;
    result.candidateFields+=parsed.fields.length; result.candidateBOMRows+=parsed.bom.length;
  } catch(error) { result.failed++; result.failedFiles.push({name,error:error.message.slice(0,180)}); }
  finally { if(task) await task.destroy(); }
}
assert.equal(result.read+result.failed,names.length);
result.largestFiles=result.largestFiles.sort((a,b)=>b.bytes-a.bytes).slice(0,5);
const json=JSON.stringify(result,null,2);
console.log(json);
if(process.argv[3]) await fs.writeFile(process.argv[3],json+'\n');
if(result.failed) process.exitCode=1;
