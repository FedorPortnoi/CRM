import { FastifyRequest, FastifyReply } from 'fastify';
import {
  suggestContactFields,
  summarizeContact,
  type ContactAiFailure,
} from '../../services/contact-ai';

type AutofillBody = {
  text: string;
};

/**
 * The service never throws for an expected condition — it returns a
 * discriminated result carrying the HTTP status it wants — so the controller is
 * a thin mapper onto the `{ error: { code, message } }` envelope.
 *
 * Statuses in play: 404 (absent / outside the org / outside the visibility
 * cone), 400 (bad input), 503 SERVICE_NOT_CONFIGURED (no API key, or the
 * service account lacks ai.languageModels.user), 504 AI_TIMEOUT, 502 for any
 * other upstream failure.
 */
function sendFailure(reply: FastifyReply, failure: ContactAiFailure) {
  return reply.code(failure.status).send({
    error: { code: failure.code, message: failure.message },
  });
}

export const ContactAiController = {
  /**
   * POST /contacts/:id/summary
   *
   * POST rather than GET: each call spends an external model quota and is not
   * safely cacheable or repeatable by an intermediary.
   */
  summary: async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const result = await summarizeContact({
      contactId: id,
      requester: {
        sub: request.user.sub,
        org_id: request.user.org_id,
        role: request.user.role,
      },
    });

    if (!result.ok) {
      return sendFailure(reply, result);
    }

    return reply.send({ data: result.data, meta: {} });
  },

  /**
   * POST /contacts/autofill
   *
   * Returns a SUGGESTION only. Nothing is written to any contact — the client
   * shows the fields for confirmation and then calls the normal contact
   * create/update endpoints.
   */
  autofill: async (request: FastifyRequest, reply: FastifyReply) => {
    const { text } = request.body as AutofillBody;

    const result = await suggestContactFields({ text });

    if (!result.ok) {
      return sendFailure(reply, result);
    }

    return reply.send({ data: result.data, meta: {} });
  },
};
