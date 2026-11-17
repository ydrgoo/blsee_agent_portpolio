import {
  accountOf,
  addKey,
  KEYS_FILE,
  loadKeys,
  parseWood,
  removeKey,
  updateKey,
  type AccessKey,
} from './keys';

const USAGE = `접근 키 관리 (파일: ${KEYS_FILE}). 관리자 화면(/admin)에서도 할 수 있다.

  npm run key -- list                   키 목록과 장작 현황
  npm run key -- add <이름> <장작>      새 키 발급 (키는 이때 한 번 보여준다)
  npm run key -- topup <이름> <장작>    장작 충전 (준 장작에 더한다)
  npm run key -- set <이름> <장작>      준 장작을 이 값으로 바꾼다
  npm run key -- disable <이름>         키 잠시 막기
  npm run key -- enable <이름>          막은 키 다시 쓰기
  npm run key -- remove <이름>          키 지우기
  npm run key -- show <이름>            키 다시 보기`;

function line(k: AccessKey): string {
  const a = accountOf(k);
  const state = k.disabled ? ' [막힘]' : '';
  const last = k.lastUsedAt
    ? ` · 마지막 사용 ${new Date(k.lastUsedAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}`
    : '';
  return `${k.name}${state}: 남은 ${a.remaining.toFixed(1)} / 준 ${a.granted} (쓴 ${a.used.toFixed(1)})${last}`;
}

const [cmd, name = '', value] = process.argv.slice(2);

try {
  switch (cmd) {
    case 'list': {
      const keys = loadKeys();
      console.log(keys.length ? keys.map(line).join('\n') : '발급한 키가 없습니다.');
      break;
    }
    case 'add': {
      const k = addKey(name, parseWood(value));
      console.log(`${line(k)}\n키: ${k.key}`);
      break;
    }
    case 'topup': {
      const wood = parseWood(value);
      console.log(line(updateKey(name, (k) => (k.granted += wood))));
      break;
    }
    case 'set': {
      const wood = parseWood(value);
      console.log(line(updateKey(name, (k) => (k.granted = wood))));
      break;
    }
    case 'disable':
      console.log(line(updateKey(name, (k) => (k.disabled = true))));
      break;
    case 'enable':
      console.log(line(updateKey(name, (k) => delete k.disabled)));
      break;
    case 'remove':
      console.log(`"${removeKey(name).name}" 키를 지웠습니다.`);
      break;
    case 'show': {
      const k = loadKeys().find((x) => x.name === name);
      if (!k) throw new Error(`"${name}" 키가 없습니다.`);
      console.log(`${line(k)}\n키: ${k.key}`);
      break;
    }
    default:
      console.log(USAGE);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
