import assert from 'node:assert/strict';
import {idleLeaseEnded as idle} from './queue-controller.mjs';
const s={activity:'idle',runtimeWorkState:'settling',runtimeWorkCount:0,activityAt:1000,runtimeWorkUpdatedAt:1000,runtimeWorkProgressAt:900};
for(const [state,now,lease,max,expected] of [[s,1299,300,1800,false],[s,1300,300,1800,true],[{...s,runtimeWorkUpdatedAt:1200},1300,300,1800,false],[{...s,runtimeWorkState:'unknown'},1300,300,1800,false],[s,1300,NaN,1800,false],[{...s,runtimeWorkProgressAt:1400},1300,300,1800,false],[{...s,runtimeWorkCount:1},1300,300,1800,false],[{...s,runtimeWorkProgressAt:0},1300,300,1800,true]])assert.equal(idle(state,800,now,lease,max),expected);
console.log('idleLeaseBoundariesPASS');
