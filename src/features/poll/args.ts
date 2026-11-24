import { poll, pollDurationHint } from './config.js';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PollInput {
  question: string;
  /** Undefined for a yes/no poll. */
  options: string[] | undefined;
  anonymous: boolean;
  durationMs: number;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Stops `<@id>`, `@everyone` and friends from becoming mentions by breaking the `@`. */
export function escapeMentions(text: string): string {
  return text.replace(/@/g, '@​');
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function parseQuestion(text: string): Parsed<string> {
  const question = clean(text);
  if (question === '') return fail('The question cannot be empty.');
  if ([...question].length > poll.maxQuestionLength) {
    return fail(`The question can be at most ${poll.maxQuestionLength} characters.`);
  }
  return { ok: true, value: escapeMentions(question) };
}

/** Parses `a | b | c` into 2 to 9 distinct, trimmed options. */
export function parseOptionList(text: string): Parsed<string[]> {
  const options = text.split('|').map(clean);
  if (options.length < poll.minOptions || options.length > poll.maxOptions) {
    return fail(`A poll needs ${poll.minOptions} to ${poll.maxOptions} options separated by "|".`);
  }
  const seen = new Set<string>();
  for (const option of options) {
    if (option === '') return fail('Options cannot be empty.');
    if ([...option].length > poll.maxOptionLength) {
      return fail(`Each option can be at most ${poll.maxOptionLength} characters.`);
    }
    const key = option.toLowerCase();
    if (seen.has(key)) return fail(`"${escapeMentions(option)}" appears twice.`);
    seen.add(key);
  }
  return { ok: true, value: options.map(escapeMentions) };
}

const units: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/** Parses `30m`, `2h` or `3d` (1 minute to 7 days). Empty or missing means the default. */
export function parsePollDuration(text: string | undefined | null): Parsed<number> {
  const value = (text ?? '').trim().toLowerCase();
  if (value === '') return { ok: true, value: poll.defaultDurationMs };
  const match = /^(\d{1,6})\s*([a-z]+)$/.exec(value);
  const unit = match?.[2] === undefined ? undefined : units[match[2]];
  if (!match?.[1] || unit === undefined) return fail(pollDurationHint);
  const ms = Number(match[1]) * unit;
  if (ms < poll.minDurationMs || ms > poll.maxDurationMs) return fail(pollDurationHint);
  return { ok: true, value: ms };
}

interface SlashInput {
  question: string;
  options?: string | null | undefined;
  duration?: string | null | undefined;
  anonymous?: boolean | null | undefined;
}

/** Validates the slash command options. */
export function parsePollInput(input: SlashInput): Parsed<PollInput> {
  const question = parseQuestion(input.question);
  if (!question.ok) return question;
  let options: string[] | undefined;
  if (input.options !== undefined && input.options !== null && input.options.trim() !== '') {
    const list = parseOptionList(input.options);
    if (!list.ok) return list;
    options = list.value;
  }
  const duration = parsePollDuration(input.duration);
  if (!duration.ok) return duration;
  return {
    ok: true,
    value: {
      question: question.value,
      options,
      anonymous: input.anonymous === true,
      durationMs: duration.value,
    },
  };
}

const openQuotes = new Set(['"', '“']);
const closeQuotes = new Set(['"', '”']);

/**
 * Parses the text after `?poll`: `question` (yes/no) or `"question" | a | b`, followed by the
 * optional trailing flags `--anon` and `--for <duration>`, in any order.
 */
export function parsePrefixPoll(raw: string): Parsed<PollInput> {
  let body = raw.trim();
  let anonymous = false;
  let duration: string | undefined;

  for (;;) {
    const anon = /(?:^|\s)--anon$/i.exec(body);
    if (anon) {
      anonymous = true;
      body = body.slice(0, anon.index).trimEnd();
      continue;
    }
    const lacking = /(?:^|\s)--for$/i.exec(body);
    if (lacking) return fail(`\`--for\` needs a duration. ${pollDurationHint}`);
    const length = /(?:^|\s)--for\s+(\S+)$/i.exec(body);
    if (length) {
      if (duration !== undefined) return fail('Give `--for` only once.');
      duration = length[1];
      body = body.slice(0, length.index).trimEnd();
      continue;
    }
    break;
  }

  let question = body;
  let optionText: string | undefined;
  const first = body[0];
  if (first !== undefined && openQuotes.has(first)) {
    const end = [...body].findIndex((char, index) => index > 0 && closeQuotes.has(char));
    if (end === -1) return fail('The closing quote is missing.');
    question = body.slice(1, end);
    const rest = body.slice(end + 1).trim();
    if (rest !== '') {
      if (!rest.startsWith('|')) return fail('Put `|` between the question and the options.');
      optionText = rest.slice(1);
    }
  } else if (body.includes('|')) {
    return fail('Put the question in quotes when you give options.');
  }

  return parsePollInput({ question, options: optionText, duration, anonymous });
}
