import {spawnBackground} from '/Users/sergekadjo/Tools/agent-relay/lib/tunnels/base.mjs';
const {child,read}=spawnBackground(process.execPath,['-e','console.log("child up"); setTimeout(()=>{},60000);']);
console.log('parent: spawned, now returning from main');
process.on('exit',code=>console.log('parent exit',code,'after',Date.now()-t0,'ms'));
const t0=Date.now();
