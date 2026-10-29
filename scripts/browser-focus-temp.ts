import {BrowserSession} from '../src/browser';
const b=new BrowserSession();const s=new AbortController().signal;
try{
await b.execute({action:'open',url:'https://example.com'},s);await b.execute({action:'new_tab',url:'https://example.org'},s);
const pages=b['context']!.pages();
const states=async()=>Promise.all(pages.map(p=>p.evaluate(()=>({url:location.href,visibility:document.visibilityState,focus:document.hasFocus()}))));
console.log('Default',JSON.stringify(await states()));
await pages[0]!.bringToFront();console.log('Switched',JSON.stringify(await states()));
const sessions=await Promise.all(pages.map(p=>b['context']!.newCDPSession(p)));
await Promise.all(sessions.map(session=>session.send('Emulation.setFocusEmulationEnabled',{enabled:false})));
console.log('Native',JSON.stringify(await states()));
await pages[1]!.bringToFront();console.log('Native switched',JSON.stringify(await states()));
}finally{await b.close()}
