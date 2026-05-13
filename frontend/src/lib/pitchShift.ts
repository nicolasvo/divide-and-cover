// Offline pitch shift via @echogarden/rubberband-wasm.
//
// The Rubber Band C API is wrapped in an emscripten module; we drive it
// directly from the main thread, allocating WASM memory for input/output
// channel pointers + sample blocks, calling study() then process()/retrieve()
// in chunks, and finally building a fresh AudioBuffer from the output.
//
// Options chosen for music with vocals (the whole reason we need this):
//   FormantPreserved  — keeps vocal formants in place so vocals don't sound
//                        like a chipmunk at +N semitones (the main fix).
//   EngineFiner       — Rubber Band's R3 algorithm, much higher fidelity
//                        than the default R2 for non-trivial shifts.
//   PitchHighQuality  — slower/better pitch transform.
//   TransientsMixed   — middle ground between crisp drums and smeared sustain.
//   DetectorSoft      — gentler on vocal onsets so they don't double-fire.
//   WindowLong        — better pitch resolution at the cost of latency
//                        (we're offline, so latency doesn't matter).

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the wasm module ships without TS types
import RubberbandFactory from '@echogarden/rubberband-wasm/rubberband.js';
// Vite resolves this to a hashed asset URL at build time.
import wasmUrl from '@echogarden/rubberband-wasm/rubberband.wasm?url';

// Bit-field from Rubber Band's RubberBandStretcher.h.
const OptionProcessOffline = 0x00000000;
const OptionTransientsMixed = 0x00000100;
const OptionDetectorSoft = 0x00000800;
const OptionPhaseLaminar = 0x00000000;
const OptionWindowLong = 0x00200000;
const OptionFormantPreserved = 0x01000000;
const OptionPitchHighQuality = 0x02000000;
const OptionEngineFiner = 0x20000000;

const RB_OPTIONS =
  OptionProcessOffline |
  OptionTransientsMixed |
  OptionDetectorSoft |
  OptionPhaseLaminar |
  OptionWindowLong |
  OptionFormantPreserved |
  OptionPitchHighQuality |
  OptionEngineFiner;

type RubberbandModule = {
  _rubberband_new(
    sampleRate: number,
    channels: number,
    options: number,
    timeRatio: number,
    pitchScale: number
  ): number;
  _rubberband_delete(stretcher: number): void;
  _rubberband_set_expected_input_duration(stretcher: number, samples: number): void;
  _rubberband_study(stretcher: number, inputPtrs: number, samples: number, final: number): void;
  _rubberband_process(stretcher: number, inputPtrs: number, samples: number, final: number): void;
  _rubberband_available(stretcher: number): number;
  _rubberband_retrieve(stretcher: number, outputPtrs: number, samples: number): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
};

let modulePromise: Promise<RubberbandModule> | null = null;
function getModule(): Promise<RubberbandModule> {
  if (!modulePromise) {
    modulePromise = RubberbandFactory({ locateFile: () => wasmUrl }) as Promise<RubberbandModule>;
  }
  return modulePromise;
}

/** Offline pitch-shift an AudioBuffer by `semitones`. Returns a new AudioBuffer
 *  of the same duration. If semitones === 0 the input buffer is returned as-is. */
export async function shiftBuffer(
  buffer: AudioBuffer,
  semitones: number,
  ctx: BaseAudioContext
): Promise<AudioBuffer> {
  if (semitones === 0) return buffer;

  const rb = await getModule();
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const samples = buffer.length;
  const pitchScale = Math.pow(2, semitones / 12);
  const blockSize = 8192;

  const stretcher = rb._rubberband_new(sampleRate, channels, RB_OPTIONS, 1.0, pitchScale);
  rb._rubberband_set_expected_input_duration(stretcher, samples);

  // Allocate one input + one output sample block (channels × blockSize × 4 bytes each)
  // plus a small array of channel pointers for the WASM ABI.
  const blockBytes = channels * blockSize * 4;
  const inDataPtr = rb._malloc(blockBytes);
  const outDataPtr = rb._malloc(blockBytes);
  const inPtrsArr = rb._malloc(channels * 4);
  const outPtrsArr = rb._malloc(channels * 4);
  for (let c = 0; c < channels; c++) {
    rb.HEAPU32[(inPtrsArr >> 2) + c] = inDataPtr + c * blockSize * 4;
    rb.HEAPU32[(outPtrsArr >> 2) + c] = outDataPtr + c * blockSize * 4;
  }

  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));

  // Output accumulators — grow as needed; final length is roughly samples but
  // can vary by a few hundred samples due to Rubber Band's startup padding.
  let outCapacity = Math.ceil(samples * 1.1) + 4096;
  const outputChannels: Float32Array[] = Array.from(
    { length: channels },
    () => new Float32Array(outCapacity)
  );
  let outLen = 0;

  const drainOutput = () => {
    while (true) {
      const avail = rb._rubberband_available(stretcher);
      if (avail <= 0) break;
      const take = Math.min(avail, blockSize);
      const got = rb._rubberband_retrieve(stretcher, outPtrsArr, take);
      if (got <= 0) break;
      // Grow output buffers if needed.
      if (outLen + got > outCapacity) {
        outCapacity = Math.max(outCapacity * 2, outLen + got);
        for (let c = 0; c < channels; c++) {
          const grown = new Float32Array(outCapacity);
          grown.set(outputChannels[c].subarray(0, outLen));
          outputChannels[c] = grown;
        }
      }
      for (let c = 0; c < channels; c++) {
        const srcOffset = (outDataPtr + c * blockSize * 4) >> 2;
        outputChannels[c].set(rb.HEAPF32.subarray(srcOffset, srcOffset + got), outLen);
      }
      outLen += got;
    }
  };

  // --- STUDY pass: let Rubber Band scan the whole signal first ---------------
  let pos = 0;
  while (pos < samples) {
    const chunk = Math.min(blockSize, samples - pos);
    for (let c = 0; c < channels; c++) {
      const dstOffset = (inDataPtr + c * blockSize * 4) >> 2;
      rb.HEAPF32.set(channelData[c].subarray(pos, pos + chunk), dstOffset);
    }
    const finalFlag = pos + chunk >= samples ? 1 : 0;
    rb._rubberband_study(stretcher, inPtrsArr, chunk, finalFlag);
    pos += chunk;
  }

  // --- PROCESS pass: feed input + retrieve output ---------------------------
  pos = 0;
  while (pos < samples) {
    const chunk = Math.min(blockSize, samples - pos);
    for (let c = 0; c < channels; c++) {
      const dstOffset = (inDataPtr + c * blockSize * 4) >> 2;
      rb.HEAPF32.set(channelData[c].subarray(pos, pos + chunk), dstOffset);
    }
    const finalFlag = pos + chunk >= samples ? 1 : 0;
    rb._rubberband_process(stretcher, inPtrsArr, chunk, finalFlag);
    pos += chunk;
    drainOutput();
  }
  drainOutput(); // anything left after the final flag

  rb._free(inDataPtr);
  rb._free(outDataPtr);
  rb._free(inPtrsArr);
  rb._free(outPtrsArr);
  rb._rubberband_delete(stretcher);

  // Output length sometimes overshoots input length by a few hundred samples
  // (startup padding). Trim to original length so seek bar / duration stay
  // accurate — quality-wise the tail is irrelevant.
  const finalLen = Math.min(outLen, samples);
  const out = ctx.createBuffer(channels, finalLen, sampleRate);
  for (let c = 0; c < channels; c++) {
    out.copyToChannel(outputChannels[c].subarray(0, finalLen), c);
  }
  return out;
}
