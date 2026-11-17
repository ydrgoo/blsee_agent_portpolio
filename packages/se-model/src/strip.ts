/**
 * 이미지 묶음(imageStrip): 사진 2~3장을 한 줄에 나란히 놓는 블록.
 * 에디터는 사진들이 같은 높이가 되도록 각 사진의 widthPercentage(줄에서 차지하는 가로 비율)를 둔다.
 * index.ts와 서로 가져오지 않도록 타입만 쓴다.
 */
import type { SeComponent } from './index';

/** 사진의 가로/세로 비. 크기를 아직 모르면(올리기 전 대기 자리) undefined */
function aspectOf(img: SeComponent): number | undefined {
  const w = Number(img.originalWidth ?? img.width);
  const h = Number(img.originalHeight ?? img.height);
  return w > 0 && h > 0 ? w / h : undefined;
}

/**
 * 묶음 안 사진들이 같은 높이가 되도록 widthPercentage를 다시 정한다 (가로/세로 비에 비례).
 * 크기를 모르는 사진이 있으면 똑같이 나눈다 (올린 뒤 fillPendingImage가 다시 맞춘다).
 */
export function fitStrip(strip: SeComponent): SeComponent {
  const imgs = (strip.images as SeComponent[] | undefined) ?? [];
  if (!imgs.length) return strip;
  const aspects = imgs.map(aspectOf);
  const known = aspects.every((a) => a !== undefined);
  const total = known ? aspects.reduce((sum, a) => sum! + a!, 0)! : imgs.length;
  imgs.forEach((img, i) => {
    img.widthPercentage = ((known ? aspects[i]! : 1) / total) * 100;
  });
  return strip;
}
