import { describe, expect, it } from 'vitest';
import { MessageFilterSchema } from '../../../backend/api/routes/messages';

describe('messages route filters', () => {
  it('accepts call as a message channel filter', () => {
    expect(MessageFilterSchema.parse({ channel: 'call' })).toMatchObject({
      channel: 'call',
      page: 1,
      per_page: 50,
    });
  });
});
