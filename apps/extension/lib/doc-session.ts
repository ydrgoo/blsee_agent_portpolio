import {
  applyBatch,
  blockImages,
  blockImageUri,
  docOrder,
  expandUri,
  findBlockImage,
  findText,
  genImageUri,
  newGenImageId,
  outline,
  parseImageUri,
  parseUri,
  PENDING_IMAGE_KEY,
  readBlocks,
  type BlockRefs,
  type EditOp,
  type SeDocumentData,
} from '@blog-helper/se-model';
import type { DocToolArgs, DocToolName, ViewImage, ViewImages } from '@blog-helper/shared';
import { bundleFontFaceCss, listBundleFonts } from './bundle-fonts';
import { findImageByHash, findImageBySource, getHtml, getImage, getImageInfo, htmlImageUri, putImage, type ImageMeta } from './image-store';
import { activeWorkspace } from './workspace';
import * as ws from './workspace-store';
import { blobHash, blobToDataUrl, blobToImageInput, fetchPstatic, imageInputToBlob, resolveImageUri, shrinkBlob } from './images';
import { renderBlocks } from './render-image';
import { renderHtml, renderSvg } from './svg';

export interface ToolRun {
  /** 서버(모델)에 돌려줄 결과 글 */
  content: string;
  /** 사이드 패널에 보여줄 한 줄 요약 (없으면 표시하지 않는다) */
  summary?: string;
  ok: boolean;
}

export interface SessionContext {
  /** 대화(글) 식별자. 만든 이미지를 이 키로 보관한다. */
  convKey: string;
  /** 이 요청에서 쓸 수 있는 보관 이미지 ID (만든 이미지, 첨부한 이미지, 라이브러리에서 찾은 이미지). 새로 만들면 여기에 더한다. */
  genIds: Set<string>;
  /** 만든 이미지 ID → 글에 넣을 때 반드시 달 캡션 (웹 이미지의 출처). 새로 만들면 여기에 더한다. */
  genCaptions: Map<string, string>;
  /** AI로 만든 이미지 ID. 글에 넣을 때 "AI 활용" 표시를 켠다. 새로 만들면 여기에 더한다. */
  genAi: Set<string>;
  /** 보관한 글 원본 이미지: 원래 이미지 주소(src) → 보관 URI. 새로 보관하면 여기에 더한다. */
  originals: Map<string, string>;
  /** 이번 요청에서 본 내용 해시 → lib URI (작업공간 없이도 세션 안 중복을 막는다) */
  byHash?: Map<string, string>;
  /** 새 이미지를 만들었을 때 (채팅에 미리보기를 보여준다). original: 보관한 글 원본의 원래 주소 */
  onImageCreated: (
    uri: string,
    meta: { source: string; instruction: string; caption?: string; ai: boolean; name?: string; original?: string },
  ) => void;
}

const VIEW_MAX_IMAGES = 10;

/**
 * 요청 하나 동안 에이전트가 읽고 고치는 작업본. 에디터에는 요청이 끝난 뒤(사용자 확인을 거쳐) 들어간다.
 */
export class DocSession {
  /** 편집 회차를 시작할 때의 작업본. 회차가 실패하면 여기로 되돌린다. */
  private roundStart: SeDocumentData | null = null;

  constructor(
    public working: SeDocumentData,
    private readonly refs: BlockRefs,
    private readonly ctx: SessionContext,
  ) {
    refs.sync(working);
  }

  outline(): string {
    return outline(this.working, this.refs);
  }

  /**
   * 가리킨 글 이미지를 lib URI로 맞춘다.
   * 넣기 대기 URI → 출처(source) → 내용 해시 순으로 찾고, 없으면 원본으로 보관한 뒤 그 URI.
   */
  async ensurePointedLib(imageSrc: string, blockId?: string): Promise<string | null> {
    if (blockId) {
      const c = this.working.document.components.find((x) => x.id === blockId);
      const pending = c?.[PENDING_IMAGE_KEY];
      if (typeof pending === 'string' && pending.startsWith('blsee://')) return pending;
    }
    const knownSrc = this.ctx.originals.get(imageSrc) ?? (await findImageBySource(imageSrc, this.ctx.convKey));
    if (knownSrc) {
      this.ctx.originals.set(imageSrc, knownSrc);
      return knownSrc;
    }
    const blob = await fetchPstatic(imageSrc);
    if (!blob) return null;
    const hash = await blobHash(blob);
    const uri = await this.store(blob, {
      kind: 'original',
      source: imageSrc,
      instruction: '가리킨 이미지 원본',
      ai: false,
      original: imageSrc,
      hash,
    });
    this.ctx.originals.set(imageSrc, uri);
    return uri;
  }

  async run(name: DocToolName, args: Record<string, unknown>): Promise<ToolRun> {
    try {
      switch (name) {
        case 'get_outline':
          return { ok: true, content: this.outline(), summary: '문서 개요 확인' };
        case 'read_blocks': {
          const a = args as DocToolArgs['read_blocks'];
          // 실행 모델이 고칠 영역 원문: 블록 머리줄 없이 블씨 마크다운 본문만 (진행 목록에 올리지 않는다).
          if (a.source) return { ok: true, content: readBlocks(this.working, this.refs, { uris: a.uris, source: true }) };
          const what = a.uris?.length ? a.uris.join(', ') : '문서 전체';
          return { ok: true, content: await this.read(a.uris), summary: `읽기: ${what}` };
        }
        case 'find_text': {
          const { query } = args as DocToolArgs['find_text'];
          const { text, count } = findText(this.working, this.refs, query);
          return { ok: true, content: text, summary: `찾기: "${query}" ${count}건` };
        }
        case 'edit_document': {
          const ops = ((args as DocToolArgs['edit_document']).operations ?? []) as EditOp[];
          const { document, messages } = applyBatch(this.working, ops, this.refs, {
            genCaption: (id) => this.ctx.genCaptions.get(id),
            genAi: (id) => this.ctx.genAi.has(id),
          });
          this.working = document;
          return {
            ok: true,
            content: `${ops.length}개 명령을 모두 적용했습니다.\n${messages.join('\n')}`,
            summary: `편집 명령 ${ops.length}개 적용`,
          };
        }
        case 'begin_round':
          this.roundStart = this.working;
          return { ok: true, content: '회차 시작' };
        case 'rollback_round': {
          if (!this.roundStart) return { ok: false, content: '실패: 시작한 회차가 없습니다.' };
          this.working = this.roundStart;
          this.roundStart = null;
          return { ok: true, content: '회차를 되돌렸습니다.', summary: '이번 회차 편집 되돌림' };
        }
        case 'render_view': {
          const { targets, perBlock } = args as DocToolArgs['render_view'];
          const view = perBlock ? await this.renderEachBlock(targets ?? []) : await this.renderView(targets ?? []);
          return {
            ok: view.images.length > 0,
            content: JSON.stringify(view),
            summary: `보기: ${targets.join(', ')}`,
          };
        }
        case 'get_image': {
          const { uri, maxSide } = args as DocToolArgs['get_image'];
          try {
            const original = await this.resolve(await this.drawnImageUri(uri));
            const blob = maxSide ? await shrinkBlob(original, maxSide) : original;
            // 내부 조회라 진행 목록에 올리지 않는다 (예전에 "이미지 변형 중"으로 오해됨).
            return { ok: true, content: JSON.stringify(await blobToImageInput(blob)) };
          } catch (err) {
            // 존재 확인 실패도 요약 없이 돌려, 인포 수정 때 빨간 줄이 도배되지 않게 한다.
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, content: `실패: ${message}` };
          }
        }
        case 'import_image': {
          const { uri: asked } = args as DocToolArgs['import_image'];
          // 인포그래픽 URI는 렌더해 둔 그림 URI로 본다.
          let uri: string;
          try {
            uri = await this.drawnImageUri(asked);
          } catch (err) {
            return { ok: false, content: `실패: ${err instanceof Error ? err.message : String(err)}` };
          }
          const parsed = parseImageUri(uri);
          if (!parsed) return { ok: false, content: `실패: ${uri}: 이미지 URI가 아닙니다.` };
          if (parsed.kind === 'gen') return { ok: true, content: uri };
          const img = findBlockImage(this.working, this.refs, parsed);
          const pending = img[PENDING_IMAGE_KEY];
          if (typeof pending === 'string') return { ok: true, content: pending };
          if (typeof img.src !== 'string') return { ok: false, content: `실패: ${uri}: 이미지 주소가 없습니다.` };
          const known = this.ctx.originals.get(img.src) ?? (await findImageBySource(img.src, this.ctx.convKey));
          if (known) {
            this.ctx.originals.set(img.src, known);
            return { ok: true, content: known };
          }
          const blob = await fetchPstatic(img.src);
          if (!blob) return { ok: false, content: `실패: ${uri}: 이미지를 받지 못했습니다.` };
          const hash = await blobHash(blob);
          const byHash = this.ctx.byHash?.get(hash) ?? (await findImageByHash(hash, this.ctx.convKey));
          if (byHash) {
            this.ctx.originals.set(img.src, byHash);
            this.ctx.byHash?.set(hash, byHash);
            return { ok: true, content: byHash };
          }
          const lib = await this.store(blob, {
            kind: 'original',
            source: img.src,
            instruction: `${uri}에 있던 원본`,
            ai: false,
            original: img.src,
            hash,
          });
          this.ctx.originals.set(img.src, lib);
          return { ok: true, content: lib, summary: `원본 보관: ${uri}` };
        }
        case 'store_image': {
          const { image, source, instruction, caption, ai, name: imageName } = args as DocToolArgs['store_image'];
          const isAi = ai ?? true;
          const uri = await this.store(await imageInputToBlob(image), {
            kind: !isAi ? 'web' : source && !/^https?:/i.test(source) ? 'edited' : 'generated',
            name: imageName?.trim() || undefined,
            source,
            instruction,
            caption: caption?.trim() || undefined,
            ai: isAi,
          });
          return { ok: true, content: uri };
        }
        case 'store_svg': {
          const { svg, instruction, name: imageName } = args as DocToolArgs['store_svg'];
          const uri = await this.store(await renderSvg(svg), { kind: 'diagram', name: imageName?.trim() || undefined, source: '', instruction, ai: true });
          return { ok: true, content: uri, summary: '설명 그림 만듦 (SVG)' };
        }
        case 'store_html': {
          const { html, width, instruction, name: imageName } = args as DocToolArgs['store_html'];
          const resolved = await this.resolveHtmlImages(html);
          const png = await renderHtml(resolved, width, await this.fontFaceCss());
          const hash = await blobHash(png);
          const uri = await this.store(png, {
            kind: 'diagram',
            name: imageName?.trim() || undefined,
            source: '',
            instruction,
            ai: true,
            hash,
          });
          const root = await activeWorkspace();
          if (root) {
            const htmlId = newGenImageId(this.ctx.genIds);
            this.ctx.genIds.add(htmlId);
            await ws.putHtml(root, html, { id: htmlId, name: imageName?.trim(), imageUri: uri });
          }
          return { ok: true, content: uri, summary: '그림 만듦 (HTML)' };
        }
        case 'get_html': {
          const { uri } = args as DocToolArgs['get_html'];
          const html = await getHtml(uri);
          if (html == null) return { ok: false, content: `실패: ${uri}: HTML 원본이 없습니다.` };
          return { ok: true, content: html, summary: `HTML 읽기: ${uri}` };
        }
        case 'list_fonts': {
          const bundle = listBundleFonts();
          const root = await activeWorkspace();
          const custom = root ? await ws.listWorkspaceFonts(root) : [];
          const lines = [
            '쓸 수 있는 글꼴 (HTML font-family에 family를 그대로 쓴다. @font-face·외부 글꼴 URL은 쓰지 않는다):',
            '',
            '[번들]',
            ...bundle.map((f) => `- ${f.name}: font-family: '${f.family}'`),
            '',
            custom.length
              ? `[작업공간]\n${custom.map((f) => `- ${f.name}: font-family: '${f.family}' (${f.uri})`).join('\n')}`
              : '[작업공간]\n(없음. 새 글꼴은 download_font로 받은 뒤 쓴다)',
          ];
          return { ok: true, content: lines.join('\n'), summary: `글꼴 목록: 번들 ${bundle.length} · 작업공간 ${custom.length}` };
        }
        case 'store_font': {
          const { name, family, source, font } = args as DocToolArgs['store_font'];
          const root = await activeWorkspace();
          if (!root) return { ok: false, content: '실패: 작업공간이 없어 글꼴을 저장할 수 없습니다.' };
          const fam = family.trim();
          const label = name.trim() || fam;
          if (!fam) return { ok: false, content: '실패: family가 비었습니다.' };
          const existing = (await ws.listWorkspaceFonts(root)).find(
            (f) => f.family.toLowerCase() === fam.toLowerCase() || (!!source && f.source === source),
          );
          if (existing) return { ok: true, content: existing.uri, summary: `글꼴 재사용: ${existing.name}` };
          const id = newGenImageId(this.ctx.genIds);
          this.ctx.genIds.add(id);
          const uri = await ws.putFont(root, await imageInputToBlob(font), {
            id,
            name: label,
            family: fam,
            source: source.trim() || undefined,
          });
          return { ok: true, content: uri, summary: `글꼴 저장: ${label}` };
        }
        case 'store_prompt': {
          const a = args as DocToolArgs['store_prompt'];
          const root = await activeWorkspace();
          if (!root) return { ok: false, content: '저장 안 함: 작업공간이 없습니다.' };
          const command = await ws.storePrompt(root, this.ctx.convKey, a);
          return { ok: true, content: command };
        }
        case 'store_research': {
          const a = args as DocToolArgs['store_research'];
          const root = await activeWorkspace();
          if (!root) return { ok: false, content: '저장 안 함: 작업공간이 없습니다.' };
          const uri = await ws.storeResearch(root, this.ctx.convKey, a);
          return { ok: true, content: uri, summary: `검색 자료 저장: ${a.query}` };
        }
        case 'search_library': {
          const a = args as DocToolArgs['search_library'];
          const root = await activeWorkspace();
          if (!root) return { ok: false, content: '실패: 작업공간이 없어 라이브러리를 쓸 수 없습니다.' };
          const hits = await ws.searchLibrary(root, a);
          // 찾은 이미지는 이 요청에서 만든 이미지처럼 글에 넣을 수 있다.
          for (const img of hits.images) {
            const id = parseUri(img.uri)?.kind === 'gen' ? img.uri.slice(img.uri.lastIndexOf('/') + 1) : null;
            if (!id) continue;
            this.ctx.genIds.add(id);
            if (img.caption) this.ctx.genCaptions.set(id, img.caption);
            if (img.ai) this.ctx.genAi.add(id);
          }
          return { ok: true, content: hits.text, summary: `라이브러리 찾기: "${a.query}" ${hits.images.length ? `이미지 ${hits.images.length}개` : ''}`.trim() };
        }
        case 'read_research': {
          const { uri } = args as DocToolArgs['read_research'];
          const root = await activeWorkspace();
          if (!root) return { ok: false, content: '실패: 작업공간이 없어 라이브러리를 쓸 수 없습니다.' };
          return { ok: true, content: await ws.readResearch(root, uri), summary: `검색 자료 읽기: ${uri}` };
        }
        default:
          return { ok: false, content: `알 수 없는 도구입니다: ${name}`, summary: `알 수 없는 도구 ${name}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `실패: ${message}`, summary: `${name} 실패: ${message}` };
    }
  }

  /**
   * 블록·범위·보관 이미지·인포 HTML·검색 자료를 한 도구로 읽는다.
   * 이미지 픽셀은 view로 보고, 인포면 HTML 원본을 돌려준다.
   */
  private async read(uris?: string[]): Promise<string> {
    if (!uris?.length) return readBlocks(this.working, this.refs, {});

    const parts: string[] = [];
    const blockUris: string[] = [];

    for (const uri of uris) {
      const u = parseUri(uri);
      if (u?.kind === 'block' || u?.kind === 'range' || u?.kind === 'image') {
        blockUris.push(uri);
        continue;
      }
      if (u?.kind === 'html') {
        const html = await getHtml(uri);
        parts.push(html != null ? `${uri} 인포 HTML\n${html}` : `실패: ${uri}: HTML 원본이 없습니다.`);
        continue;
      }
      if (u?.kind === 'gen') {
        parts.push(await this.readLibImage(uri));
        continue;
      }
      if (/^blsee:\/\/lib\/research\/[a-z0-9]+$/.test(uri)) {
        const root = await activeWorkspace();
        if (!root) {
          parts.push(`실패: ${uri}: 작업공간이 없어 라이브러리를 쓸 수 없습니다.`);
          continue;
        }
        try {
          parts.push(`${uri} 검색 자료\n${await ws.readResearch(root, uri)}`);
        } catch (err) {
          parts.push(`실패: ${uri}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      parts.push(`실패: ${uri}: 알 수 없는 URI 형식이다.`);
    }

    if (blockUris.length) parts.unshift(readBlocks(this.working, this.refs, { uris: blockUris }));
    return parts.join('\n\n');
  }

  /** 보관 이미지: 인포면 HTML, 아니면 메타 + view 안내 */
  private async readLibImage(uri: string): Promise<string> {
    const info = await getImageInfo(this.ctx.convKey, uri);
    const htmlRef = info?.htmlUri ?? uri;
    const html = await getHtml(htmlRef);
    if (html != null) {
      const name = info?.name ? ` (${info.name})` : '';
      const htmlNote = info?.htmlUri ? ` · 원본 ${info.htmlUri}` : '';
      return `${uri} 인포그래픽${name}${htmlNote}\n${html}`;
    }
    const lines = [`${uri} 이미지`];
    if (info?.name) lines.push(`이름: ${info.name}`);
    if (info?.kind) lines.push(`종류: ${info.kind}`);
    if (info?.instruction) lines.push(`지시: ${info.instruction}`);
    if (info?.caption) lines.push(`캡션: ${info.caption}`);
    if (info?.source) lines.push(`출처: ${info.source}`);
    lines.push('(픽셀·화면 내용은 view로 본다. 인포그래픽 HTML 원본은 없다.)');
    return lines.join('\n');
  }

  /** 번들 + 작업공간 글꼴 @font-face CSS */
  private async fontFaceCss(): Promise<string> {
    const bundle = await bundleFontFaceCss();
    const root = await activeWorkspace();
    const custom = root ? await ws.workspaceFontFaceCss(root) : '';
    return [bundle, custom].filter(Boolean).join('\n');
  }

  /** HTML 안의 blsee://lib/images/… 를 data URL로 바꿔 그리기용으로 만든다. */
  private async resolveHtmlImages(html: string): Promise<string> {
    const uris = [...html.matchAll(/blsee:\/\/lib\/images\/[a-z0-9]+/gi)].map((m) => m[0]);
    if (!uris.length) return html;
    let out = html;
    for (const uri of [...new Set(uris)]) {
      try {
        const blob = await this.resolve(uri);
        const dataUrl = await blobToDataUrl(blob);
        out = out.split(uri).join(dataUrl);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`${uri}: HTML에 넣은 이미지를 읽지 못했습니다. (${why})`);
      }
    }
    return out;
  }

  /** 만든 이미지를 이 대화의 새 URI로 보관하고 채팅에 미리보기를 띄운다. 같은 내용이면 기존 URI를 쓴다. */
  private async store(
    blob: Blob,
    meta: ImageMeta & { source: string; instruction: string; original?: string; hash?: string },
  ): Promise<string> {
    const hash = meta.hash ?? (await blobHash(blob));
    const existing = this.ctx.byHash?.get(hash) ?? (await findImageByHash(hash, this.ctx.convKey));
    if (existing) {
      // 해시만 남고 파일이 없는 고아는 재사용하지 않는다.
      const alive = await getImage(this.ctx.convKey, existing);
      if (alive) {
        this.ctx.byHash?.set(hash, existing);
        const id = existing.slice(existing.lastIndexOf('/') + 1);
        this.ctx.genIds.add(id);
        return existing;
      }
      this.ctx.byHash?.delete(hash);
    }
    const id = newGenImageId(this.ctx.genIds);
    const uri = genImageUri(id);
    const { original: _, ...stored } = meta;
    const kept = await putImage(this.ctx.convKey, uri, blob, { ...stored, source: meta.source || undefined, hash });
    this.ctx.genIds.add(kept.slice(kept.lastIndexOf('/') + 1));
    this.ctx.byHash ??= new Map();
    this.ctx.byHash.set(hash, kept);
    if (meta.caption) this.ctx.genCaptions.set(id, meta.caption);
    if (meta.ai) this.ctx.genAi.add(id);
    if (kept === uri) this.ctx.onImageCreated(uri, meta);
    return kept;
  }

  /** 인포그래픽 URI(blsee://lib/infographics/…)면 렌더해 둔 그림 URI로 바꾼다. 다른 URI는 그대로. */
  private async drawnImageUri(uri: string): Promise<string> {
    if (parseUri(uri)?.kind !== 'html') return uri;
    const drawn = await htmlImageUri(uri);
    if (!drawn) throw new Error(`${uri}: 렌더해 둔 그림이 없습니다.`);
    return drawn;
  }

  private resolve(uri: string): Promise<Blob> {
    return resolveImageUri(uri, { doc: this.working, refs: this.refs, convKey: this.ctx.convKey });
  }

  /**
   * 대상마다 그림을 만든다.
   * - 블록, 범위 URI: 블록을 데이터로 그린다. 단, 이미지 블록 하나만 지정하면 사진 원본을 쓴다.
   * - 이미지 URI: 이미지 원본
   */
  /**
   * 대상 블록·범위 안 블록을 하나씩 글에 보이는 모습으로 그린다 (이미지 블록도 원본이 아니라 그린 모습).
   * 라벨은 블록 참조. 점검이 블록 경계에서 높이로 묶을 때 쓴다.
   */
  private async renderEachBlock(targets: string[]): Promise<ViewImages> {
    const images: ViewImage[] = [];
    const notes: string[] = [];
    const order = docOrder(this.working, this.refs);
    for (const target of targets) {
      for (const ref of expandUri(target, order)) {
        if (images.length >= VIEW_MAX_IMAGES) {
          notes.push(`그림이 ${VIEW_MAX_IMAGES}장을 넘어 ${ref}부터는 그리지 않았습니다.`);
          return { images, notes };
        }
        try {
          const at = order.indexOf(ref);
          const r = await renderBlocks(this.working, at, at, (x) => this.resolve(x).catch(() => null));
          for (const png of r.pngs) images.push({ label: ref, ...(await blobToImageInput(png)) });
          if (r.missingImages) notes.push(`${ref}: 이미지 ${r.missingImages}개를 받지 못해 회색으로 그렸습니다.`);
        } catch (err) {
          notes.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { images, notes };
  }

  private async renderView(targets: string[]): Promise<ViewImages> {
    const images: ViewImage[] = [];
    const notes: string[] = [];
    const add = async (label: string, blob: Blob) => images.push({ label, ...(await blobToImageInput(blob)) });

    for (const target of targets) {
      if (images.length >= VIEW_MAX_IMAGES) {
        notes.push(`그림이 ${VIEW_MAX_IMAGES}장을 넘어 ${target}부터는 그리지 않았습니다.`);
        break;
      }
      try {
        const u = parseUri(target);
        if (!u) throw new Error('대상 형식이 아닙니다.');
        if (u.kind === 'image' || u.kind === 'gen' || u.kind === 'html') {
          // 인포그래픽 URI는 렌더해 둔 그림을 본다.
          await add(target, await this.resolve(await this.drawnImageUri(target)));
          continue;
        }
        const order = docOrder(this.working, this.refs);
        const blocks = expandUri(target, order);
        const from = order.indexOf(blocks[0]);
        const to = order.indexOf(blocks[blocks.length - 1]);

        const single = this.working.document.components[from];
        const singleImage = from === to && single['@ctype'] === 'image' && blockImages(single).length === 1;
        if (singleImage) {
          const uri = typeof single[PENDING_IMAGE_KEY] === 'string' ? (single[PENDING_IMAGE_KEY] as string) : blockImageUri(blocks[0]);
          await add(`${target} (이미지 원본)`, await this.resolve(uri));
          continue;
        }

        const r = await renderBlocks(this.working, from, to, (x) => this.resolve(x).catch(() => null));
        const label = target;
        for (const [i, png] of r.pngs.entries()) {
          await add(r.pngs.length > 1 ? `${label} (${i + 1}/${r.pngs.length})` : label, png);
        }
        if (r.missingImages) notes.push(`${label}: 이미지 ${r.missingImages}개를 받지 못해 회색으로 그렸습니다.`);
      } catch (err) {
        notes.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { images, notes };
  }
}
