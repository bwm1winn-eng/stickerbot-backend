import sharp from 'sharp';

export function stickerBackground(value = 'white', color = '#ffffff') {
  if (!['white','black','color','transparent'].includes(value) || typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)) {
    const error = new Error('invalid background'); error.code = 'INVALID_BACKGROUND'; throw error;
  }
  return { mode: value, color: value === 'white' ? '#ffffff' : value === 'black' ? '#000000' : color.toLowerCase() };
}

export function backgroundPrompt(background) {
  if (background.mode === 'transparent') return 'isolated single character, plain pure white background, no scenery, no checkerboard pattern';
  return `solid ${background.color} background, no scenery`;
}

// Border-connected white matting is a bounded fallback for an opaque provider
// response. Unlike globally deleting white pixels, it preserves enclosed white details.
// Reject backgrounds that cannot be separated instead of labelling an opaque PNG transparent.
export async function normalizeSticker(buffer, background = stickerBackground(), { upload = false } = {}) {
  const pipeline = sharp(buffer, { limitInputPixels: 16_000_000, animated: false, failOn: 'warning' }).rotate();
  const metadata = await pipeline.metadata();
  if (!['png','jpeg','webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error('unsupported static image');
  const { data, info } = await pipeline.resize(512,512,{ fit:'contain', background:{r:255,g:255,b:255,alpha:0} }).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if (background.mode === 'transparent' && !upload) {
    // Transparent contain padding is not evidence that the subject background is removed.
    const originalAlpha = metadata.hasAlpha && (await sharp(buffer).stats()).channels.at(-1)?.mean < 254.9;
    if (!originalAlpha) {
      const total=info.width*info.height, visited=new Uint8Array(total), queue=new Uint32Array(total); let head=0,tail=0;
      const enqueue = (i) => { if(visited[i])return; const p=i*4; if(data[p+3]===0 || Math.min(data[p],data[p+1],data[p+2])>=232 && Math.max(data[p],data[p+1],data[p+2])-Math.min(data[p],data[p+1],data[p+2])<=20){visited[i]=1;queue[tail++]=i;} };
      for(let x=0;x<info.width;x++){enqueue(x);enqueue((info.height-1)*info.width+x);}
      for(let y=0;y<info.height;y++){enqueue(y*info.width);enqueue(y*info.width+info.width-1);}
      while(head<tail){const i=queue[head++],x=i%info.width;data[i*4+3]=0;if(x)enqueue(i-1);if(x<info.width-1)enqueue(i+1);if(i>=info.width)enqueue(i-info.width);if(i<total-info.width)enqueue(i+info.width);}
      if(tail<total*.03 || tail>total*.97) {const error=new Error('background could not be separated');error.code='TRANSPARENT_BACKGROUND_UNAVAILABLE';throw error;}
    }
  }
  let output=sharp(data,{raw:{width:info.width,height:info.height,channels:4}});
  if (!upload && background.mode!=='transparent') output=output.flatten({background:background.color});
  // Bound the Telegram upload and database payload, preserving full-colour PNG first.
  let result=await output.png({compressionLevel:9}).toBuffer();
  if(result.length>512_000) result=await sharp(result).png({palette:true,quality:100,effort:7}).toBuffer();
  if(result.length>512_000) throw new Error('image exceeds sticker size limit');
  return result;
}
