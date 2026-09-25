/* eslint-disable semi */
// mJS (Shelly's script engine) does not reliably auto-insert semicolons —
// in particular a bare `return` immediately followed by a new statement can
// fail to parse without an explicit `;`. Keep semicolons throughout this
// file; the `eslint-disable semi` above stops `standard --fix` undoing them.

// Runs on a Shelly Gen2+ device with BLE enabled and an outbound WebSocket
// connection configured (Ws.SetConfig -> wss://<hangtime-worker>/ws?token=...).
// Scans for BTHome BLE advertisements from the configured Shelly BLU H&T
// sensors and re-emits temperature/humidity/button data as a script event
// ("bthome_report"), which the outbound WebSocket connection then forwards
// to the hangtime Worker as a NotifyEvent — no native BLE-gateway component
// adoption required.
//
// Decoder lifted from ble-shelly-motion.js (same BTHome v2 unpacking logic).

/** ***************** START CHANGE HERE *******************/
const CONFIG = {
  debug: false,
  active: false, // passive scan is enough for BTHome adverts

  // Shelly BLU H&T MAC address (lowercase) -> hangtime location.
  sensors: {
    'c0:2c:ed:77:14:fe': 'ute', // outdoor
    'c0:2c:ed:49:0f:2b': 'inne' // indoor / fridge
  }
};
/** ***************** STOP CHANGE HERE *******************/

const BTHOME_SVC_ID_STR = 'fcd2';

const uint8 = 0;
const int8 = 1;
const uint16 = 2;
const int16 = 3;
const uint24 = 4;
const int24 = 5;

const BTH = {
  0x00: { n: 'pid', t: uint8 },
  0x01: { n: 'battery', t: uint8, u: '%' },
  0x02: { n: 'temperature', t: int16, f: 0.01, u: 'tC' },
  0x03: { n: 'humidity', t: uint16, f: 0.01, u: '%' },
  0x21: { n: 'motion', t: uint8 },
  0x2e: { n: 'humidity', t: uint8, u: '%' },
  0x3a: { n: 'button', t: uint8 },
  0x45: { n: 'temperature', t: int16, f: 0.1, u: 'tC' }
};

function getByteSize (type) {
  if (type === uint8 || type === int8) return 1;
  if (type === uint16 || type === int16) return 2;
  if (type === uint24 || type === int24) return 3;
  return 255;
}

const BTHomeDecoder = {
  utoi: function (num, bitsz) {
    const mask = 1 << (bitsz - 1);
    return num & mask ? num - (1 << bitsz) : num;
  },
  getUInt8: function (buffer) { return buffer.at(0); },
  getInt8: function (buffer) { return this.utoi(this.getUInt8(buffer), 8); },
  getUInt16LE: function (buffer) { return 0xffff & ((buffer.at(1) << 8) | buffer.at(0)); },
  getInt16LE: function (buffer) { return this.utoi(this.getUInt16LE(buffer), 16); },
  getUInt24LE: function (buffer) {
    return 0x00ffffff & ((buffer.at(2) << 16) | (buffer.at(1) << 8) | buffer.at(0));
  },
  getInt24LE: function (buffer) { return this.utoi(this.getUInt24LE(buffer), 24); },
  getBufValue: function (type, buffer) {
    if (buffer.length < getByteSize(type)) return null;
    let res = null;
    if (type === uint8) res = this.getUInt8(buffer);
    if (type === int8) res = this.getInt8(buffer);
    if (type === uint16) res = this.getUInt16LE(buffer);
    if (type === int16) res = this.getInt16LE(buffer);
    if (type === uint24) res = this.getUInt24LE(buffer);
    if (type === int24) res = this.getInt24LE(buffer);
    return res;
  },
  unpack: function (buffer) {
    if (typeof buffer !== 'string' || buffer.length === 0) return null;
    const result = {};
    const _dib = buffer.at(0);
    result.encryption = !!(_dib & 0x1);
    result.BTHome_version = _dib >> 5;
    if (result.BTHome_version !== 2) return null;
    if (result.encryption) return result;
    buffer = buffer.slice(1);

    let _bth;
    let _value;
    while (buffer.length > 0) {
      _bth = BTH[buffer.at(0)];
      if (typeof _bth === 'undefined') {
        console.log('BTH: Unknown type');
        break;
      }
      buffer = buffer.slice(1);
      _value = this.getBufValue(_bth.t, buffer);
      if (_value === null) break;
      if (typeof _bth.f !== 'undefined') _value = _value * _bth.f;

      if (typeof result[_bth.n] === 'undefined') {
        result[_bth.n] = _value;
      } else if (Array.isArray(result[_bth.n])) {
        result[_bth.n].push(_value);
      } else {
        result[_bth.n] = [result[_bth.n], _value];
      }

      buffer = buffer.slice(getByteSize(_bth.t));
    }
    return result;
  }
};

// last BTHome packet id seen per address, to drop duplicate adverts
const lastPacketId = {};

function onReceivedPacket (loc, data) {
  const report = { location: loc };
  let hasData = false;

  if (typeof data.temperature !== 'undefined') { report.temperature = data.temperature; hasData = true; }
  if (typeof data.humidity !== 'undefined') { report.humidity = data.humidity; hasData = true; }
  if (typeof data.button !== 'undefined' && data.button > 0) { report.button = data.button; hasData = true; }

  if (!hasData) return;

  if (CONFIG.debug) console.log('hangtime relay ->', JSON.stringify(report));
  Shelly.emitEvent('bthome_report', report);
}

function BLEScanCallback (event, result) {
  if (event !== BLE.Scanner.SCAN_RESULT) return;
  if (typeof result.service_data === 'undefined' || typeof result.service_data[BTHOME_SVC_ID_STR] === 'undefined') return;

  const addr = (result.addr || '').toLowerCase();
  const location = CONFIG.sensors[addr];
  if (!location) return; // not one of our configured sensors

  const unpacked = BTHomeDecoder.unpack(result.service_data[BTHOME_SVC_ID_STR]);
  if (unpacked === null || typeof unpacked === 'undefined' || unpacked.encryption) return;

  if (lastPacketId[addr] === unpacked.pid) return; // duplicate advert
  lastPacketId[addr] = unpacked.pid;

  onReceivedPacket(location, unpacked);
}

function init () {
  const bleConfig = Shelly.getComponentConfig('ble');
  if (!bleConfig.enable) {
    console.log('Error: Bluetooth is not enabled, please enable it from settings');
    return;
  }

  if (BLE.Scanner.isRunning()) {
    console.log('Info: BLE scanner already running, using existing configuration');
  } else {
    const scanner = BLE.Scanner.Start({ duration_ms: BLE.Scanner.INFINITE_SCAN, active: CONFIG.active });
    if (!scanner) console.log('Error: Can not start BLE scanner');
  }

  BLE.Scanner.Subscribe(BLEScanCallback);
  console.log('hangtime relay started, watching', JSON.stringify(CONFIG.sensors));
}

init();
