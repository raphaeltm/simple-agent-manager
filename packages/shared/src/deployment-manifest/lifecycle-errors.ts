/**
 * How SAM's recorded error text for a deployment environment begins when placement or a stop
 * fails. The API writes messages with these prefixes; the web app tells the failures apart by
 * them until environments carry a typed failure kind (idea 01M5NBRGEV68MMK65BV0BT06EP).
 */
export const DEPLOYMENT_PLACEMENT_ERROR_PREFIX = 'Deployment node placement';
export const DEPLOYMENT_STOP_ERROR_PREFIX = 'Stop failed';
