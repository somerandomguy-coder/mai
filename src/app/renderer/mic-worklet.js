// Audio thread for the 🎙️ button: turns the mic into 16 kHz mono 16-bit chunks of 100 ms for live
// transcription. The AudioContext normally runs at 16 kHz already; if the browser picked another rate,
// each output sample averages the input samples it covers (a cheap low-pass before downsampling).
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.acc = 0;
    this.accN = 0;
    this.pos = 0;
    this.chunk = new Int16Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accN++;
      this.pos += 1;
      if (this.pos < this.step) continue;
      this.pos -= this.step;
      const v = Math.max(-1, Math.min(1, this.acc / this.accN));
      this.acc = 0;
      this.accN = 0;
      this.chunk[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(1600);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("mic-tap", MicTap);
