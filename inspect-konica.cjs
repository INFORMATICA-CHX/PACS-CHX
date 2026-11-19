const fs = require('fs');
const lines = fs.readFileSync('public/konica-base-mapping.dat', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
lines.slice(0, 5).forEach((line, i) => {
  const fields = line.split('\t');
  console.log('LINHA ' + i + ': campos=' + fields.length);
  fields.forEach((value, j) => console.log('  [' + j + ']="' + value + '"'));
});
