const fs = require('node:fs/promises');
const path = require('node:path');

const DAY_MS = 86_400_000;
const DAYS = 365;
const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const dayInVietnam = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function dayKey(date) {
  const parts = new Map(dayInVietnam.formatToParts(date).map(({ type, value }) => [type, value]));
  return [parts.get('year'), parts.get('month'), parts.get('day')].join('-');
}

function shiftDay(day, offset) {
  return new Date(Date.parse(day + 'T00:00:00Z') + offset * DAY_MS).toISOString().slice(0, 10);
}

function displayDay(day) {
  return day.split('-').reverse().join('.');
}

async function getPages(endpoint, parameters, request, allowEmpty = false) {
  const url = new URL(endpoint, 'https://api.github.com');
  url.search = new URLSearchParams({ ...parameters, per_page: '100' });
  const rows = [];

  for (let page = 1; ; page += 1) {
    url.searchParams.set('page', String(page));
    const response = await request(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'profile-commit-activity',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (allowEmpty && page === 1 && response.status === 409 && /repository is empty/i.test(body.message)) {
        return [];
      }
      throw new Error('GitHub API ' + response.status + ' for ' + url.pathname + ': ' + (body.message || response.statusText));
    }

    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('Unexpected GitHub API response for ' + url.pathname);
    rows.push(...batch);
    if (!/rel="next"/.test(response.headers.get('link') || '')) return rows;
  }
}

async function collectActivity(owner, { now = new Date(), request = fetch } = {}) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(owner)) throw new Error('Set PROFILE_OWNER to your GitHub username.');

  const end = dayKey(now);
  const start = shiftDay(end, 1 - DAYS);
  // The API filters by time. The chart buckets commits by the calendar day in Vietnam.
  const startTime = Date.parse(start + 'T00:00:00+07:00');
  const since = new Date(startTime - 1000).toISOString();
  const ownerPath = encodeURIComponent(owner);
  const repos = await getPages('/users/' + ownerPath + '/repos', { type: 'owner' }, request);
  const seen = new Set();
  const activeRepos = new Set();
  const counts = new Map();

  for (const repo of repos) {
    const endpoint = '/repos/' + ownerPath + '/' + encodeURIComponent(repo.name) + '/commits';
    const commits = await getPages(endpoint, { author: owner, sha: repo.default_branch, since }, request, true);

    for (const commit of commits) {
      if (commit.author?.login?.toLowerCase() !== owner.toLowerCase()) continue;
      const day = dayKey(new Date(commit.commit.committer.date));
      if (day < start || day > end) continue;

      activeRepos.add(repo.name);
      if (seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      counts.set(day, (counts.get(day) || 0) + 1);
    }
  }

  return { end, publicRepos: repos.length, activeRepos: activeRepos.size, byDay: [...counts.entries()].sort() };
}

function renderActivity({ end, publicRepos, activeRepos, byDay }) {
  const start = shiftDay(end, 1 - DAYS);
  const counts = new Map(byDay);
  const days = Array.from({ length: DAYS }, (_, index) => {
    const date = shiftDay(start, index);
    return { date, count: counts.get(date) || 0 };
  });

  let longest = 0;
  let running = 0;
  let activeDays = 0;
  let total = 0;
  let last = '';
  for (const day of days) {
    running = day.count ? running + 1 : 0;
    longest = Math.max(longest, running);
    if (!day.count) continue;
    activeDays += 1;
    total += day.count;
    last = day.date;
  }

  let current = 0;
  let cursor = days.at(-1).count ? days.length - 1 : days.length - 2;
  while (cursor >= 0 && days[cursor].count) {
    current += 1;
    cursor -= 1;
  }

  const shades = ['#1c2a46', '#365bd7', '#8facff', '#afc4ff', '#d7e3ff'];
  function colorFor(count) {
    if (count >= 5) return shades[4];
    if (count >= 3) return shades[3];
    return shades[count];
  }

  const metrics = [
    ['TỔNG COMMIT', total, '#8facff'],
    ['NGÀY CÓ COMMIT', activeDays, '#9ac3ff'],
    ['CHUỖI HIỆN TẠI', current, '#aebde6'],
    ['CHUỖI DÀI NHẤT', longest, '#b6c2f7'],
  ];
  const cards = metrics.map(([label, value, color], index) => {
    const x = 32 + index * 267;
    return [
      '<rect x="' + x + '" y="64" width="255" height="82" rx="10" fill="#14203a" stroke="#293958"/>',
      '<text x="' + (x + 17) + '" y="88" font-size="14" letter-spacing="1.15" fill="#afbdd7">' + label + '</text>',
      '<text x="' + (x + 17) + '" y="130" font-size="39" font-weight="730" fill="' + color + '">' + value + '</text>',
      '<path d="M' + (x + 211) + ' 121h25" stroke="' + color + '" stroke-width="3" stroke-linecap="round"/>',
    ].join('\n');
  }).join('\n');

  const offset = (new Date(start + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const columns = days.map((day, index) => {
    const position = index + offset;
    const x = 85 + Math.floor(position / 7) * 18;
    const y = 212 + (position % 7) * 17;
    return '<rect x="' + x + '" y="' + y + '" width="14" height="14" rx="3" fill="' +
      colorFor(day.count) + '"><title>' + displayDay(day.date) + ' · ' + day.count + ' commit</title></rect>';
  }).join('\n');

  const months = [];
  let lastMonthColumn = -3;
  for (const [index, day] of days.entries()) {
    const column = Math.floor((index + offset) / 7);
    if ((index === 0 || day.date.endsWith('-01')) && column - lastMonthColumn >= 3) {
      months.push('<text x="' + (85 + column * 18) + '" y="199" font-size="14">T' + Number(day.date.slice(5, 7)) + '</text>');
      lastMonthColumn = column;
    }
  }

  const legend = ['0', '1', '2', '3–4', '5+'].map((label, index) => {
    const x = 809 + index * 53;
    return '<rect x="' + x + '" y="354" width="13" height="13" rx="3" fill="' + shades[index] + '"/>' +
      '<text x="' + (x + 18) + '" y="366" font-size="14">' + label + '</text>';
  }).join('\n');

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="415" viewBox="0 0 1120 415" role="img" aria-labelledby="title desc">',
    '<title id="title">Nhật ký commit · 365 ngày</title>',
    '<desc id="desc">' + total + ' commit trên ' + activeDays + ' ngày trong các repo công khai sở hữu, nhánh mặc định. Dữ liệu đến ' + displayDay(end) + '.</desc>',
    '<rect x=".5" y=".5" width="1119" height="414" rx="18" fill="#0b1428" stroke="#2c3b5c"/>',
    '<rect x="32" y="23" width="8" height="8" rx="2" fill="#8facff"/>',
    '<g font-family="Segoe UI, Arial, sans-serif">',
    '<text x="50" y="37" font-size="19" font-weight="720" letter-spacing="1.5" fill="#f2f5ff">NHẬT KÝ COMMIT</text>',
    '<text x="1088" y="36" text-anchor="end" font-size="15" fill="#a9b8d4">DỮ LIỆU ĐẾN · ' + displayDay(end) + '</text>',
    cards,
    '<text x="32" y="176" fill="#f2f5ff" font-size="18" font-weight="680">365 ngày</text>',
    '<text x="120" y="176" fill="#a9b8d4" font-size="16">' + displayDay(start) + ' — ' + displayDay(end) + '</text>',
    '<text x="1088" y="176" text-anchor="end" fill="#a9b8d4" font-size="16">' + activeRepos + ' / ' + publicRepos + ' repo công khai có commit</text>',
    '<g fill="#a9b8d4">',
    months.join('\n'),
    '<text x="51" y="224" font-size="14">T2</text>',
    '<text x="51" y="258" font-size="14">T4</text>',
    '<text x="51" y="292" font-size="14">T6</text>',
    columns,
    legend,
    '<text x="32" y="366" font-size="16">' + (last ? 'Commit gần nhất · ' + displayDay(last) : 'Chưa có commit trong khoảng thời gian này') + '</text>',
    '<path d="M32 379H1088" stroke="#293958"/>',
    '<text x="32" y="399" font-size="14">Nhánh mặc định · repo công khai sở hữu · ngày theo UTC+7</text>',
    '</g></g></svg>',
    '',
  ].join('\n');
}

async function main() {
  const activity = await collectActivity(process.env.PROFILE_OWNER || '');
  const target = path.join(__dirname, '..', 'assets', 'activity.svg');
  const temporary = target + '.tmp';
  await fs.writeFile(temporary, renderActivity(activity), 'utf8');
  await fs.rename(temporary, target);
  console.log('Updated ' + target + ' through ' + activity.end);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { collectActivity, renderActivity };

