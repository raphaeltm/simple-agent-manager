import { Container, getContainer } from '@cloudflare/containers';
export class Probe extends Container { defaultPort = 8080; sleepAfter = '5m'; enableInternet = true; }
export default { async fetch(req, env) { return getContainer(env.PROBE, 'one').fetch(req); } };
