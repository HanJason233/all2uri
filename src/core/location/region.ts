export type RegionLookupMethod = "NODE_NAME" | "LOCAL_GEOIP" | "REMOTE_API";

export const REGION_LOOKUP_OPTIONS: ReadonlyArray<{
  value: RegionLookupMethod;
  title: string;
  description: string;
}> = [
  {
    value: "NODE_NAME",
    title: "节点名称匹配地区",
    description: "从节点名称中的地区名称、国家代码或国旗识别地区。",
  },
  {
    value: "LOCAL_GEOIP",
    title: "本地 GeoIP 数据库",
    description: "解析节点服务器地址后，使用内置或自定义 geoip.dat 查询归属地区。",
  },
  {
    value: "REMOTE_API",
    title: "远程 API",
    description: "解析节点地址后，仅将公网 IP 发送至 ipwho.is 查询归属地区。",
  },
];

export const DEFAULT_REGION_LOOKUP_METHODS: RegionLookupMethod[] = [
  "NODE_NAME",
  "LOCAL_GEOIP",
  "REMOTE_API",
];

export const UNKNOWN_REGION_CODE = "??";

const ISO_COUNTRY_CODES = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" "),
);

const countryNames = new Map<string, string>();
const displayNames = typeof Intl.DisplayNames === "function"
  ? [
      new Intl.DisplayNames(["zh-CN"], { type: "region" }),
      new Intl.DisplayNames(["zh-TW"], { type: "region" }),
      new Intl.DisplayNames(["en"], { type: "region" }),
    ]
  : [];

for (const code of ISO_COUNTRY_CODES) {
  for (const names of displayNames) {
    const name = names.of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) countryNames.set(normalizeText(name), code);
  }
}

const COUNTRY_ALIASES: Record<string, string> = {
  "中国大陆": "CN", "中國大陸": "CN", "中国台湾": "TW", "中國台灣": "TW", "中國臺灣": "TW",
  "中国香港": "HK", "中國香港": "HK", "中国澳门": "MO", "中國澳門": "MO",
  "美国": "US", "美國": "US", "英国": "GB", "英國": "GB", uk: "GB", "u.k.": "GB", usa: "US",
  "united states of america": "US", can: "CA", jpn: "JP", kor: "KR", chn: "CN", rus: "RU",
  deu: "DE", fra: "FR", aus: "AU", sgp: "SG", hkg: "HK", twn: "TW",
  "俄罗斯": "RU", "俄羅斯": "RU", "俄国": "RU", "俄國": "RU", 日本: "JP", 韩国: "KR", 韓國: "KR",
  南韩: "KR", 南韓: "KR", 朝鲜: "KP", 朝鮮: "KP", 台湾: "TW", 臺灣: "TW", 香港: "HK",
  澳门: "MO", 澳門: "MO", 新加坡: "SG", 加拿大: "CA", 澳大利亚: "AU", 澳大利亞: "AU",
  澳洲: "AU", 德国: "DE", 德國: "DE", 法国: "FR", 法國: "FR", 荷兰: "NL", 荷蘭: "NL",
  印度: "IN", 泰国: "TH", 泰國: "TH", 越南: "VN", 菲律宾: "PH", 菲律賓: "PH",
  马来西亚: "MY", 馬來西亞: "MY", 印度尼西亚: "ID", 印度尼西亞: "ID", 印尼: "ID",
  土耳其: "TR", 瑞士: "CH", 瑞典: "SE", 挪威: "NO", 芬兰: "FI", 芬蘭: "FI", 丹麦: "DK",
  丹麥: "DK", 波兰: "PL", 波蘭: "PL", 乌克兰: "UA", 烏克蘭: "UA", 以色列: "IL", 南非: "ZA",
  墨西哥: "MX", 巴西: "BR", 智利: "CL", 阿根廷: "AR", 新西兰: "NZ", 紐西蘭: "NZ",
};

for (const [name, code] of Object.entries(COUNTRY_ALIASES)) {
  countryNames.set(normalizeText(name), code);
}

export function normalizeRegionCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return code === UNKNOWN_REGION_CODE || ISO_COUNTRY_CODES.has(code) ? code : null;
}

export function countryNameForCode(value: string): string {
  const code = normalizeRegionCode(value);
  if (!code || code === UNKNOWN_REGION_CODE) return "未知地区";
  const localNames: Record<string, string> = {
    CN: "中国大陆",
    TW: "中国台湾",
    HK: "中国香港",
    MO: "中国澳门",
  };
  if (localNames[code]) return localNames[code];
  return displayNames[0]?.of(code) ?? code;
}

export function countryCodeFromNodeName(value: string): string | null {
  const text = value.trim();
  if (!text) return null;

  const codePoints = Array.from(text, character => character.codePointAt(0)!);
  for (let index = 0; index < codePoints.length - 1; index++) {
    const first = codePoints[index];
    const second = codePoints[index + 1];
    if (first >= 0x1f1e6 && first <= 0x1f1ff && second >= 0x1f1e6 && second <= 0x1f1ff) {
      return String.fromCharCode(65 + first - 0x1f1e6, 65 + second - 0x1f1e6);
    }
  }

  const normalized = normalizeText(text);
  let best: { start: number; length: number; code: string } | null = null;
  for (const [name, code] of countryNames) {
    const start = normalized.indexOf(name);
    if (start >= 0 && (!best || start < best.start || (start === best.start && name.length > best.length))) {
      best = { start, length: name.length, code };
    }
  }

  for (const match of normalized.matchAll(/[a-z]{2}/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if ((start > 0 && /[a-z]/.test(normalized[start - 1])) || (end < normalized.length && /[a-z]/.test(normalized[end]))) continue;
    if (!ISO_COUNTRY_CODES.has(match[0].toUpperCase())) continue;
    if (!best || start < best.start || (start === best.start && match[0].length > best.length)) {
      best = { start, length: match[0].length, code: match[0].toUpperCase() };
    }
  }

  return best?.code ?? null;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
