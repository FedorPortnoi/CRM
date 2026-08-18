import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The invite client: the race between the two things that can look an invite up,
 * and the shape guards that decide what this app is willing to POST.
 *
 * Nothing here renders. `settleInviteLookup` is module-level and takes its
 * setters as arguments precisely so the ordering inside it — which is the whole
 * defect surface — can be driven directly, with the lookup promise resolved by
 * hand at the moment the other racer has already won. A renderer would only
 * obscure that, and this repo has no react-test-renderer to do it with.
 *
 * The regex tests are checked against the REAL generators in
 * backend/services/invites.ts rather than against hand-typed samples. A client
 * guard tightened to an exact length is only safe if it accepts every value the
 * server can actually mint, and that is a fact about the server, so it is read
 * from the server.
 */

// InviteScreen imports the whole React Native surface. None of it is exercised —
// only StyleSheet.create runs at import time — so the mocks exist to make the
// module loadable in node, not to model anything.
vi.mock('react-native', () => {
  const passthrough = (): null => null;
  return {
    ActivityIndicator: passthrough,
    Image: passthrough,
    ImageBackground: passthrough,
    KeyboardAvoidingView: passthrough,
    Platform: { OS: 'ios' },
    Pressable: passthrough,
    SafeAreaView: passthrough,
    ScrollView: passthrough,
    StyleSheet: {
      create: <T,>(sheet: T): T => sheet,
      absoluteFillObject: {},
    },
    Text: passthrough,
    TextInput: passthrough,
    View: passthrough,
    Clipboard: { getString: vi.fn() },
  };
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: (): null => null }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: (): null => null }));
vi.mock('expo-blur', () => ({ BlurView: (): null => null }));
vi.mock('expo-router', () => ({
  Stack: { Screen: (): null => null },
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('expo-linking', () => ({
  getInitialURL: async (): Promise<string | null> => null,
  useURL: (): string | null => null,
}));
vi.mock('../../../src/store/userStore', () => ({
  useUserStore: Object.assign(() => ({ isLoading: false, error: null, acceptInvite: vi.fn() }), {
    getState: () => ({ error: null, user: null, token: null }),
  }),
}));
vi.mock('../../../src/utils/api', () => ({
  API_URL: 'https://api.example.com/api/v1',
  authHeaders: vi.fn(),
}));

import { settleInviteLookup } from '../../../src/screens/InviteScreen';
import {
  handoffFromClipboard,
  tokenFromUrl,
  type InviteLookupResult,
  type InvitePreview,
} from '../../../src/utils/inviteDiscovery';
import {
  CLAIM_TTL_MS,
  generateHandoffToken,
  generateLinkToken,
} from '../../../backend/services/invites';

const PREVIEW: InvitePreview = {
  name: 'Анна Соколова',
  role: 'member',
  org_name: 'ООО «Ромашка»',
  accept_token: 'accept-token-from-the-winner',
};

/** The exact 409 the server returns to the loser of a concurrent lookup. */
const IN_PROGRESS: InviteLookupResult = {
  ok: false,
  code: 'INVITE_IN_PROGRESS',
  message:
    'Приглашение уже открыто на другом устройстве. Завершите регистрацию там или откройте ссылку заново.',
};

type Recorder = {
  spinner: boolean[];
  errors: (string | null)[];
  previews: InvitePreview[];
  handlers: Parameters<typeof settleInviteLookup>[1];
};

function recorder(isStale: () => boolean): Recorder {
  const spinner: boolean[] = [];
  const errors: (string | null)[] = [];
  const previews: InvitePreview[] = [];
  return {
    spinner,
    errors,
    previews,
    handlers: {
      setIsLookingUp: (value) => spinner.push(value),
      setLookupError: (message) => errors.push(message),
      applyPreview: (preview) => previews.push(preview),
      isStale,
    },
  };
}

/** A lookup whose response lands only when the test says so. */
function deferredLookup(): {
  lookup: () => Promise<InviteLookupResult>;
  respond: (result: InviteLookupResult) => void;
} {
  let respond!: (result: InviteLookupResult) => void;
  const pending = new Promise<InviteLookupResult>((res) => {
    respond = res;
  });
  return { lookup: () => pending, respond };
}

function sourceOf(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

function sourceWithoutComments(relativePath: string): string {
  return sourceOf(relativePath)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('invite lookup race', () => {
  it('drops a losing result instead of painting it under the winner’s form', async () => {
    // The invitee typed a code and pressed «Продолжить». While that request is in
    // flight an App Link arrives, wins, and paints the credentials form.
    let winnerHasPainted = false;
    const rec = recorder(() => winnerHasPainted);
    const { lookup, respond } = deferredLookup();

    const inFlight = settleInviteLookup(lookup, rec.handlers);
    winnerHasPainted = true;
    respond(IN_PROGRESS);
    await inFlight;

    // Only the clear issued before the request. Nothing red lands underneath a
    // form the invitee is already filling in.
    expect(rec.errors).toEqual([null]);
    expect(rec.previews).toEqual([]);
  });

  it('drops a losing preview too, rather than replacing the form under the cursor', async () => {
    let winnerHasPainted = false;
    const rec = recorder(() => winnerHasPainted);
    const { lookup, respond } = deferredLookup();

    const inFlight = settleInviteLookup(lookup, rec.handlers);
    winnerHasPainted = true;
    respond({ ok: true, preview: PREVIEW, via: 'code' });
    await inFlight;

    expect(rec.previews).toEqual([]);
  });

  it('still shows the error when nothing else has won', async () => {
    const rec = recorder(() => false);

    await settleInviteLookup(async () => IN_PROGRESS, rec.handlers);

    expect(rec.errors).toEqual([null, IN_PROGRESS.message]);
    expect(rec.previews).toEqual([]);
  });

  it('applies the preview on the ordinary success path', async () => {
    const rec = recorder(() => false);

    await settleInviteLookup(async () => ({ ok: true, preview: PREVIEW, via: 'code' }), rec.handlers);

    expect(rec.previews).toEqual([PREVIEW]);
    expect(rec.errors).toEqual([null]);
  });

  it('clears the spinner on the guarded exit, not only on the ordinary one', async () => {
    // The latch: nothing else in the screen sets isLookingUp back to false, so a
    // guarded return that skipped it left «Продолжить» disabled for good.
    let winnerHasPainted = false;
    const rec = recorder(() => winnerHasPainted);
    const { lookup, respond } = deferredLookup();

    const inFlight = settleInviteLookup(lookup, rec.handlers);
    expect(rec.spinner).toEqual([true]);

    winnerHasPainted = true;
    respond(IN_PROGRESS);
    await inFlight;

    expect(rec.spinner).toEqual([true, false]);
  });

  it('clears the spinner when the effect that started the lookup was cancelled', async () => {
    // Unmount / a newer URL supersedes this one. Same rule: the flag is state on
    // a screen that may still be alive, and it is not this branch's business to
    // decide otherwise.
    const rec = recorder(() => true);

    await settleInviteLookup(async () => IN_PROGRESS, rec.handlers);

    expect(rec.spinner).toEqual([true, false]);
    expect(rec.errors).toEqual([null]);
  });

  it('is the only lookup-settling code in the screen — both racers share it', () => {
    const source = sourceWithoutComments('src/screens/InviteScreen.tsx');
    const settleCalls = source.match(/settleInviteLookup\(/g) ?? [];

    // One definition plus the two call sites: the link effect and the code submit.
    expect(settleCalls).toHaveLength(3);
    // No hand-rolled second copy left behind.
    expect(source).not.toContain('await lookupInvite(');
  });
});

describe('clipboard handoff guard', () => {
  it('accepts every handoff the server can actually mint', () => {
    for (let i = 0; i < 500; i += 1) {
      const handoff = generateHandoffToken();
      expect(handoffFromClipboard(handoff)).toBe(handoff);
    }
  });

  it('tolerates the whitespace a copy picks up', () => {
    const handoff = generateHandoffToken();
    expect(handoffFromClipboard(`  ${handoff}\n`)).toBe(handoff);
  });

  it('rejects a symbols-disabled password of exactly the right length', () => {
    // 22 characters, alphabet-clean, and therefore accepted by the old
    // /^[A-Za-z0-9_-]{22}$/ — which is the shape the guard's comment claimed to
    // exclude. The encoder cannot end a handoff in '1'.
    const password = 'K7mQz2LpXv9RtWn4Bc8Ds1';
    expect(password).toHaveLength(22);
    expect(handoffFromClipboard(password)).toBeNull();
  });

  it('rejects the three quarters of same-length noise the encoder could not produce', () => {
    const impossibleTails = 'BCDEFGHIJKLMNOPRSTUVXYZabcdefhijklmnopqrstuvxyz0123456789-_';
    for (const tail of impossibleTails) {
      expect(handoffFromClipboard(`AAAAAAAAAAAAAAAAAAAAA${tail}`)).toBeNull();
    }
  });

  it('rejects everything that is not a bare token of that shape', () => {
    for (const junk of [
      '',
      '   ',
      'привет, во сколько встречаемся?',
      'https://4kub.ru/i#abcdefghijklmnopqrstuv',
      '+7 999 123-45-67',
      'A'.repeat(21),
      'A'.repeat(23),
      `${generateHandoffToken()} ${generateHandoffToken()}`,
      'correct horse battery A',
    ]) {
      expect(handoffFromClipboard(junk)).toBeNull();
    }
    expect(handoffFromClipboard(null)).toBeNull();
    expect(handoffFromClipboard(undefined)).toBeNull();
  });

  it('does not exclude what its comment admits it does not exclude', () => {
    // A UUID is 16 bytes, so base64url of one has exactly a handoff's shape. This
    // is pinned deliberately: the guard's comment says a base64url UUID gets
    // through, and a comment that overstates is the defect this file exists for.
    // If somebody later finds a real tightening, this test fails and the comment
    // has to be rewritten with it.
    const uuidBytes = Buffer.from('7f3e1a4c9b2d4e6f8a0c1d2e3f405162', 'hex');
    const asHandoff = uuidBytes.toString('base64url');
    expect(asHandoff).toHaveLength(22);
    expect(handoffFromClipboard(asHandoff)).toBe(asHandoff);

    const comment = sourceOf('src/utils/inviteDiscovery.ts');
    expect(comment).toContain('does NOT exclude');
  });
});

describe('link token guard', () => {
  it('accepts every link token the server can actually mint', () => {
    for (let i = 0; i < 500; i += 1) {
      const token = generateLinkToken();
      expect(tokenFromUrl(`https://4kub.ru/i#${token}`)).toBe(token);
    }
  });

  it('is exactly the length the comment claims — 32 bytes base64url', () => {
    expect(generateLinkToken()).toHaveLength(43);
    expect(tokenFromUrl(`https://4kub.ru/i#${'A'.repeat(43)}`)).toBe('A'.repeat(43));
    // The old {20,200} accepted both of these while its comment said the shorter
    // one "means something else".
    expect(tokenFromUrl(`https://4kub.ru/i#${'A'.repeat(20)}`)).toBeNull();
    expect(tokenFromUrl(`https://4kub.ru/i#${'A'.repeat(42)}`)).toBeNull();
    expect(tokenFromUrl(`https://4kub.ru/i#${'A'.repeat(44)}`)).toBeNull();
  });

  it('ignores fragments that are not tokens at all', () => {
    for (const url of ['https://4kub.ru/i', 'https://4kub.ru/i#', 'https://4kub.ru/i#pricing']) {
      expect(tokenFromUrl(url)).toBeNull();
    }
    expect(tokenFromUrl(null)).toBeNull();
  });
});

describe('invite screen copy and reachability', () => {
  it('gives the manual-code screen a door on the login screen', () => {
    // The door is the "Я новый сотрудник" tab itself (auth.tabJoin) — it used
    // to toggle in place to a company-code + manager-password form, which a
    // real invitee read as "I'm a new employee" and walked straight into,
    // typing the invite claim code into fields meant for something else
    // entirely. It now navigates to /invite directly instead.
    const login = sourceWithoutComments('src/screens/LoginScreen.tsx');

    expect(login).toContain("router.push('/invite'");
    expect(login).toContain("t('auth.tabJoin')");
    expect(login).not.toContain('managerPassword');
    expect(login).not.toContain('companyCode');
  });

  it('does not promise a claim-code lifetime from a clock that started earlier', () => {
    const invite = sourceOf('src/screens/InviteScreen.tsx');

    // The old sentence — «Код действует 15 минут» — read as if the clock started
    // when this screen appeared. It starts at InviteController.open, before the
    // store download.
    expect(invite).not.toContain('Код действует 15 минут');
    expect(invite).toContain('открылась страница приглашения');
  });

  it('quotes the server’s claim-code lifetime rather than a remembered one', () => {
    // The defect was a UI string that had drifted from the constant behind it, so
    // the replacement is pinned to that constant instead of to a number somebody
    // typed once. CLAIM_TTL_MS has already moved from 15 minutes to 45 while this
    // screen said 15.
    const invite = sourceOf('src/screens/InviteScreen.tsx');

    expect(invite).toContain(`${CLAIM_TTL_MS / 60_000} минут`);
  });

  it('keeps the install landing page claim-code lifetime aligned with the server', () => {
    const landingPage = sourceOf('website/i.html');

    expect(landingPage).toContain(`Код действует ${CLAIM_TTL_MS / 60_000} минут.`);
  });

  it('does not treat a dismissed share sheet as a saved invite link', () => {
    const team = sourceOf('src/app/settings/team.tsx');
    const share = team.slice(
      team.indexOf('const shareLink'),
      team.indexOf('const confirmRevokeInvite'),
    );
    const sharedAction = share.indexOf('result.action === Share.sharedAction');

    expect(share).toContain('await Share.share');
    expect(sharedAction).toBeGreaterThan(-1);
    expect(share.indexOf('setLinkSaved(true)')).toBeGreaterThan(sharedAction);
  });
});
