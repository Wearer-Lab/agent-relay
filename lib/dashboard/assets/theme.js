'use strict';
(()=>{
 const key='agent-relay-theme',valid=value=>['light','dark','system'].includes(value);
 const media=window.matchMedia('(prefers-color-scheme: dark)');
 let mode='dark';
 // The cookie keeps this non-sensitive preference across local dashboard ports.
 let saved;
 try{saved=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith(key+'='))?.slice(key.length+1);}catch{}
 if(valid(saved))mode=saved;
 else try{const local=localStorage.getItem(key);if(valid(local))mode=local;}catch{}
 const apply=()=>{document.documentElement.dataset.theme=mode==='system'?(media.matches?'dark':'light'):mode;};
 apply();media.addEventListener('change',()=>{if(mode==='system')apply();});
 document.addEventListener('DOMContentLoaded',()=>{
  const control=document.getElementById('theme');control.value=mode;
  control.addEventListener('change',()=>{
   if(!valid(control.value))return;
   mode=control.value;apply();
   try{localStorage.setItem(key,mode);}catch{}
   try{document.cookie=`${key}=${mode}; Max-Age=31536000; Path=/; SameSite=Strict`;}catch{}
  });
 });
})();
