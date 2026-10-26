"use strict"

// RE Engine .asrc (version 31, Ace Attorney Investigations Collection /
// AJ:AA Trilogy) support. An "srcd" asrc file is a header followed by a
// regular RIFF/WAV file (an Ogg file on the Switch version), so we strip the
// header and hand the payload to vgmstream.
// Format reverse-engineered by osyu: https://gist.github.com/osyu/c3390a4c1c32aaef0ea6d59c2fcb4ea0
//
// srcd header layout (little endian):
//   0   "srcd"
//   4   u32 always 0
//   8   u32 payload size
//   12  "wav "
//   16  u32 streaming flag
//   20  u32 id
//   24  u32 unk0
//   28  u32 channels
//   32  u32 samples (may be off by one)
//   36  u32 urate
//   40  u32 sample rate
//   44  u32 bit depth
//   48  u32 always 1
//   52  u8  loop flag
//   53  u32 loop start (sample)
//   57  u32 loop end (sample, inclusive)
//   61  u32 marker count, followed by count * (u32, u32)
//   ..  9 bytes of zeros, u32 unk1
//   ..  u32 header size, u32 payload data offset

var Asrc = (() => {
	var textDecoder = new TextDecoder("latin1")
	
	function tag(view, offset){
		return textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset, 4))
	}
	
	async function isAsrc(file){
		var magic = textDecoder.decode(await file.slice(0, 4).arrayBuffer())
		return magic === "srcd" || magic === "srch"
	}
	
	async function parseHeader(file){
		// fixed part of the header, up to and including the marker count
		var view = new DataView(await file.slice(0, 65).arrayBuffer())
		var magic = view.byteLength >= 4 ? tag(view, 0) : ""
		if(magic === "srch"){
			throw new Error("This asrc file only contains an id and no audio data. " +
				"The audio is in the file with the same name under natives/stm/streaming/sound")
		}
		if(magic !== "srcd" || view.byteLength < 65 || tag(view, 12) !== "wav "){
			throw new Error("Not a valid asrc file")
		}
		var info = {
			channels: view.getUint32(28, true),
			samples: view.getUint32(32, true),
			rate: view.getUint32(40, true),
			loop: view.getUint8(52) === 1,
			loopStart: view.getUint32(53, true),
			loopEnd: view.getUint32(57, true)
		}
		var markCount = view.getUint32(61, true)
		if(markCount > 0x10000){
			throw new Error("Not a valid asrc file")
		}
		// fixed part + markers (8 bytes each) + 9 zero bytes + unk1 + header size + data offset
		info.headerSize = 65 + markCount * 8 + 9 + 4 + 4 + 4
		var tail = new DataView(await file.slice(info.headerSize - 8, info.headerSize).arrayBuffer())
		if(tail.byteLength < 8 || tail.getUint32(0, true) !== info.headerSize){
			throw new Error("Unsupported asrc version (only version 31 is supported)")
		}
		// dataOffset is the position of the raw samples inside the embedded wav,
		// so it isn't needed to locate the wav itself
		return info
	}
	
	// Adds a "smpl" chunk with a single forward loop, which is where vgmstream
	// reads loop points from in wav files. Returns null if not applicable.
	function addLoop(wav, start, end){
		var view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
		if(wav.length < 12 || tag(view, 0) !== "RIFF" || tag(view, 8) !== "WAVE"){
			return null
		}
		var pos = 12
		var rate = 0
		while(pos + 8 <= wav.length){
			var id = tag(view, pos)
			var size = view.getUint32(pos + 4, true)
			if(id === "smpl"){
				return null // already has loop info, don't override
			}
			if(id === "fmt " && pos + 12 + 4 <= wav.length){
				rate = view.getUint32(pos + 12, true)
			}
			pos += 8 + size + (size & 1)
		}
		var chunk = new Uint8Array(8 + 36 + 24)
		var cv = new DataView(chunk.buffer)
		chunk.set([0x73, 0x6d, 0x70, 0x6c]) // "smpl"
		cv.setUint32(4, 36 + 24, true)
		cv.setUint32(8 + 8, rate ? Math.round(1e9 / rate) : 0, true) // sample period
		cv.setUint32(8 + 28, 1, true) // loop count
		cv.setUint32(8 + 36 + 4, 0, true) // loop type: forward
		cv.setUint32(8 + 36 + 8, start, true)
		cv.setUint32(8 + 36 + 12, end, true)
		var out = new Uint8Array(wav.length + chunk.length)
		out.set(wav)
		out.set(chunk, wav.length)
		new DataView(out.buffer).setUint32(4, out.length - 8, true)
		return out
	}
	
	// Returns a File with the embedded audio, named so that vgmstream
	// picks the right parser by extension.
	async function unwrap(file){
		var info = await parseHeader(file)
		var payload = file.slice(info.headerSize)
		var head = new Uint8Array(await payload.slice(0, 4).arrayBuffer())
		var magic = String.fromCharCode(...head)
		var ext
		if(magic === "RIFF"){
			ext = ".wav"
		}else if(magic === "OggS"){
			ext = ".ogg"
		}else{
			throw new Error("Unsupported audio data inside asrc file")
		}
		var parts = [payload]
		if(ext === ".wav" && info.loop && info.loopEnd > info.loopStart){
			var wav = new Uint8Array(await payload.arrayBuffer())
			var looped = addLoop(wav, info.loopStart, info.loopEnd)
			if(looped){
				parts = [looped]
			}
		}
		return new File(parts, file.name + ext)
	}
	
	return {isAsrc: isAsrc, unwrap: unwrap}
})()
