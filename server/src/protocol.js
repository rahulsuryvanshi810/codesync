// Wire protocol, compatible with the y-websocket message format:
//   [varUint messageType][payload]
// MSG_SYNC carries y-protocols sync messages (step1 = state vector, step2 = missing
// updates, update = incremental change). MSG_AWARENESS carries presence (cursor,
// selection, user name and color) and is never persisted.
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

export function syncStep1Message(doc) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  return encoding.toUint8Array(enc);
}

export function updateMessage(update) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

export function awarenessMessage(awareness, clientIds) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds));
  return encoding.toUint8Array(enc);
}
