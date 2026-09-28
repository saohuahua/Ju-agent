import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function renderDiagram(spec){
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const wrap=(s,max)=>{const out=[];let line='',n=0;for(const c of s){const w=c.codePointAt(0)>255?1:.55;if(n+w>max){out.push(line);line='';n=0;}line+=c;n+=w;}if(line)out.push(line);return out};
const text=(x,y,ls,cls='body',gap=24)=>`<text x="${x}" y="${y}" text-anchor="middle" class="${cls}">${ls.map((l,i)=>`<tspan x="${x}" dy="${i?gap:0}">${esc(l)}</tspan>`).join('')}</text>`;
const p=[`<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${spec.height}" viewBox="0 0 1120 ${spec.height}" role="img" aria-labelledby="title desc"><title id="title">${esc(spec.title)}</title><desc id="desc">${esc(spec.subtitle)}</desc><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L7 4L0 8" fill="#52758a"/></marker><style>text{font-family:'Microsoft YaHei','Noto Sans SC',sans-serif;fill:#253b49}.title{font-size:25px;font-weight:700}.subtitle{font-size:16px;fill:#607581}.head{font-size:19px;font-weight:700}.body{font-size:16px}.label{font-size:14px;fill:#405e70}.group{font-size:16px;font-weight:700;fill:#4c6b7d}</style></defs><rect width="1120" height="${spec.height}" fill="#f8fafb" rx="16"/>`,text(560,43,[spec.title],'title'),text(560,74,[spec.subtitle],'subtitle')];
for(const g of spec.groups||[])p.push(`<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="14" fill="${g.fill||'#f0f4f7'}" stroke="#cfdae1"/>`,text(g.x+g.w/2,g.y+27,[g.label],'group'));
for(const e of spec.edges||[]){p.push(`<path d="${e.path}" fill="none" stroke="#52758a" stroke-width="1.8" ${e.dashed?'stroke-dasharray="6 5"':''} marker-end="url(#arrow)"/>`);if(e.label){const ls=Array.isArray(e.label)?e.label:[e.label];const w=Math.max(...ls.map(s=>[...s].reduce((n,c)=>n+(c.codePointAt(0)>255?14:7.5),0)))+14;p.push(`<rect x="${e.x-w/2}" y="${e.y-16}" width="${w}" height="${ls.length*20+3}" rx="4" fill="#f8fafb"/>`,text(e.x,e.y,ls,'label',20));}}
for(const n of spec.nodes){const fill=n.fill||'#e8eff5';if(n.shape==='diamond')p.push(`<path d="M${n.x+n.w/2} ${n.y}L${n.x+n.w} ${n.y+n.h/2}L${n.x+n.w/2} ${n.y+n.h}L${n.x} ${n.y+n.h/2}Z" fill="${fill}" stroke="#b8cbd7"/>`);else if(n.shape==='db')p.push(`<path d="M${n.x} ${n.y+13}C${n.x} ${n.y-4} ${n.x+n.w} ${n.y-4} ${n.x+n.w} ${n.y+13}V${n.y+n.h-13}C${n.x+n.w} ${n.y+n.h+4} ${n.x} ${n.y+n.h+4} ${n.x} ${n.y+n.h-13}Z" fill="${fill}" stroke="#b8cbd7"/><ellipse cx="${n.x+n.w/2}" cy="${n.y+13}" rx="${n.w/2}" ry="13" fill="${fill}" stroke="#b8cbd7"/>`);else p.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="${fill}" stroke="#b8cbd7"/>`);
const ts=wrap(n.title,n.w/20-1),ls=(n.lines||[]).flatMap(s=>wrap(s,n.w/16-1.5)),yy=n.y+(n.h-ts.length*25-ls.length*23-(ls.length?5:0))/2+20+(n.shape==='db'?6:0);p.push(text(n.x+n.w/2,yy,ts,'head',25));if(ls.length)p.push(text(n.x+n.w/2,yy+ts.length*25+5,ls,'body',23));}
for(const l of spec.labels||[])p.push(text(l.x,l.y,Array.isArray(l.text)?l.text:[l.text],'label'));
p.push(text(560,spec.height-23,[spec.footer||'实线表示调用或推进　虚线表示返回或逻辑关联　持久位置以数据库形状标注'],'label'),'</svg>');return p.join('\n')+'\n';
}

const directory = dirname(fileURLToPath(import.meta.url))
const specs = JSON.parse(readFileSync(join(directory, 'diagram-specs.json'), 'utf8'))
for (const spec of specs) writeFileSync(join(directory, spec.id + '.svg'), renderDiagram(spec), 'utf8')
