'use strict';

const HSTAR_VOICE_TARGET_RATE = 16000;
const HSTAR_VOICE_FRAME_SAMPLES = 320;

class HstarVoiceProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const configuredRate = Number(options.processorOptions?.sourceRate);
    this.sourceRate = configuredRate > 0
      ? configuredRate
      : Number(globalThis.sampleRate || 48000);
    this.targetRate = HSTAR_VOICE_TARGET_RATE;
    this.sourceStep = this.sourceRate / this.targetRate;
    this.sourceSamples = [];
    this.sourcePosition = 0;
    this.pcmSamples = [];
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels?.length && channels[0]?.length) this.consume(channels);
    return true;
  }

  consume(channels) {
    const sampleCount = channels[0].length;
    for (let index = 0; index < sampleCount; index += 1) {
      let sum = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        sum += Number(channels[channel][index] || 0);
      }
      this.sourceSamples.push(sum / channels.length);
    }
    this.resampleAvailable();
  }

  resampleAvailable() {
    while (this.sourcePosition < this.sourceSamples.length) {
      const leftIndex = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - leftIndex;
      if (fraction > Number.EPSILON && leftIndex + 1 >= this.sourceSamples.length) break;

      const left = this.sourceSamples[leftIndex];
      const right = this.sourceSamples[leftIndex + 1] ?? left;
      const sample = left + ((right - left) * fraction);
      this.pcmSamples.push(this.toPcm16(sample));
      this.sourcePosition += this.sourceStep;
      this.flushFrames();
    }

    const consumed = Math.min(Math.floor(this.sourcePosition), this.sourceSamples.length);
    if (consumed > 0) {
      this.sourceSamples.splice(0, consumed);
      this.sourcePosition -= consumed;
      if (Math.abs(this.sourcePosition) < Number.EPSILON) this.sourcePosition = 0;
    }
  }

  toPcm16(value) {
    const clamped = Math.max(-1, Math.min(1, Number(value) || 0));
    return Math.round(clamped * (clamped < 0 ? 32768 : 32767));
  }

  flushFrames() {
    while (this.pcmSamples.length >= HSTAR_VOICE_FRAME_SAMPLES) {
      const frame = new Int16Array(
        this.pcmSamples.splice(0, HSTAR_VOICE_FRAME_SAMPLES),
      );
      this.port.postMessage(frame, [frame.buffer]);
    }
  }
}

registerProcessor('hstar-voice-processor', HstarVoiceProcessor);
