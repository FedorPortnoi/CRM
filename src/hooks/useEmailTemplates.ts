// Data layer for the email-template screens (list / editor).
//
// Backend: GET    /api/v1/email-templates?page=&per_page=&q=
//          POST   /api/v1/email-templates                       (owner/admin)
//          GET    /api/v1/email-templates/placeholders
//          POST   /api/v1/email-templates/preview               (owner/admin, unsaved draft)
//          GET    /api/v1/email-templates/:id
//          PATCH  /api/v1/email-templates/:id                   (owner/admin)
//          DELETE /api/v1/email-templates/:id                   (owner/admin)
//          GET    /api/v1/email-templates/:id/preview?contact_id=<uuid>
//
// Two things are deliberate here:
//   1. The bearer token is part of every query key. That is what keeps these responses out
//      of the plaintext AsyncStorage cache (see shouldDehydrateQuery in utils/queryClient.ts)
//      — a preview rendered against a real contact carries that contact's PII.
//   2. Errors surface as a TemplateApiError carrying the server's `code`. The screens map the
//      code to a Russian i18n string; the server's own message is operator-facing English and
//      is never rendered.
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useUserStore } from '../store/userStore';
import { API_URL } from '../utils/api';

// Mirrors the Zod limits in backend/api/routes/email-templates.ts.
export const MAX_TEMPLATE_NAME_LENGTH = 200;
export const MAX_TEMPLATE_SUBJECT_LENGTH = 500;
export const MAX_TEMPLATE_BODY_LENGTH = 50_000;

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  created_at: string;
  updated_at: string;
  creator: { id: string; name: string } | null;
};

export type TemplatePlaceholderSource = 'contact' | 'organization' | 'system';

export type TemplatePlaceholder = {
  key: string;
  source: TemplatePlaceholderSource;
  example: string;
};

export type RenderedPreview = {
  subject: string;
  text: string;
  html: string;
  /** Placeholders the catalogue does not know — they render as literal {{text}}. */
  unresolved: string[];
  /** Known placeholders whose value is empty for this contact. */
  blank: string[];
};

export type PreviewMeta = {
  contact_id: string | null;
  sample: boolean;
  unknown_placeholders?: string[];
};

export type TemplateEnvelope = {
  data: EmailTemplate;
  meta: { unknown_placeholders: string[] };
};

export type TemplateListEnvelope = {
  data: EmailTemplate[];
  meta: { total: number; page: number; per_page: number };
};

export type PreviewEnvelope = {
  data: RenderedPreview;
  meta: PreviewMeta;
};

export class TemplateApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    // The retry policy in utils/queryClient keys off "status 401" in the message.
    super(`Email templates request failed with status ${status} (${code})`);
    this.name = 'TemplateApiError';
    this.code = code;
    this.status = status;
  }
}

type ErrorEnvelope = { error?: { code?: string; message?: string } };

async function templateRequest<T>(
  path: string,
  token: string,
  init?: { method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const parsed = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const code = (parsed as ErrorEnvelope | null)?.error?.code ?? 'REQUEST_FAILED';
    throw new TemplateApiError(res.status, code);
  }

  return parsed as T;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export function useEmailTemplates(search: string): UseQueryResult<TemplateListEnvelope, Error> {
  const token = useUserStore((s) => s.token);
  const trimmed = search.trim();
  const query = trimmed.length > 0 ? `?per_page=100&q=${encodeURIComponent(trimmed)}` : '?per_page=100';

  return useQuery<TemplateListEnvelope, Error>({
    queryKey: ['email-templates', 'list', trimmed, token],
    queryFn: () => templateRequest<TemplateListEnvelope>(`/email-templates${query}`, token ?? ''),
    enabled: Boolean(token),
    // Keeps the previous result on screen while a new search runs, so typing does not flash
    // the empty state.
    placeholderData: keepPreviousData,
  });
}

export function useEmailTemplate(id: string | null): UseQueryResult<TemplateEnvelope, Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<TemplateEnvelope, Error>({
    queryKey: ['email-templates', 'detail', id, token],
    queryFn: () => templateRequest<TemplateEnvelope>(`/email-templates/${id ?? ''}`, token ?? ''),
    enabled: Boolean(token) && Boolean(id),
  });
}

export function useTemplatePlaceholders(): UseQueryResult<TemplatePlaceholder[], Error> {
  const token = useUserStore((s) => s.token);

  return useQuery<TemplatePlaceholder[], Error>({
    queryKey: ['email-templates', 'placeholders', token],
    queryFn: async () => {
      const body = await templateRequest<{ data: TemplatePlaceholder[] }>(
        '/email-templates/placeholders',
        token ?? '',
      );
      return body.data;
    },
    enabled: Boolean(token),
    // The catalogue is a compile-time constant on the server.
    staleTime: 60 * 60 * 1000,
  });
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export type TemplateInput = {
  name: string;
  subject: string;
  body: string;
};

/** Create when `id` is null, update otherwise. Both are owner/admin on the server. */
export function useSaveEmailTemplate(
  id: string | null,
): UseMutationResult<TemplateEnvelope, Error, TemplateInput> {
  const token = useUserStore((s) => s.token);
  const queryClient = useQueryClient();

  return useMutation<TemplateEnvelope, Error, TemplateInput>({
    mutationFn: (input) =>
      templateRequest<TemplateEnvelope>(
        id === null ? '/email-templates' : `/email-templates/${id}`,
        token ?? '',
        { method: id === null ? 'POST' : 'PATCH', body: input },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['email-templates'] });
    },
  });
}

export function useDeleteEmailTemplate(): UseMutationResult<{ data: { id: string } }, Error, string> {
  const token = useUserStore((s) => s.token);
  const queryClient = useQueryClient();

  return useMutation<{ data: { id: string } }, Error, string>({
    mutationFn: (id) =>
      templateRequest<{ data: { id: string } }>(`/email-templates/${id}`, token ?? '', {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['email-templates'] });
    },
  });
}

export type PreviewRequest = {
  /** Saved template id — used for the read-only (viewer) preview route. */
  templateId: string | null;
  subject: string;
  body: string;
  /** Render against this real contact instead of the server's sample values. */
  contactId: string | null;
  /** Owner/admin may preview an unsaved draft; everyone else gets the saved version. */
  canPreviewDraft: boolean;
};

/**
 * Previews on demand rather than on every keystroke — each call renders server-side against
 * either the sample catalogue or one real contact (which goes through the visibility cone).
 */
export function usePreviewEmailTemplate(): UseMutationResult<PreviewEnvelope, Error, PreviewRequest> {
  const token = useUserStore((s) => s.token);

  return useMutation<PreviewEnvelope, Error, PreviewRequest>({
    mutationFn: (input) => {
      if (input.canPreviewDraft) {
        return templateRequest<PreviewEnvelope>('/email-templates/preview', token ?? '', {
          method: 'POST',
          body: {
            subject: input.subject,
            body: input.body,
            ...(input.contactId === null ? {} : { contact_id: input.contactId }),
          },
        });
      }

      const suffix = input.contactId === null ? '' : `?contact_id=${encodeURIComponent(input.contactId)}`;
      return templateRequest<PreviewEnvelope>(
        `/email-templates/${input.templateId ?? ''}/preview${suffix}`,
        token ?? '',
      );
    },
  });
}
