import {mkdir,copyFile,cp,rm} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
for(const file of ['index.html','workspace.css','workspace.mjs','engine.mjs','ingest.mjs','instructions.mjs','business.mjs','backup.mjs','drawing.mjs','reparse.mjs','vision-ui.mjs','vision-adapter.mjs','vision-facts.mjs'])await copyFile(file,'dist/'+file);
await cp('vendor','dist/vendor',{recursive:true});
console.log('Static package prepared in dist');
