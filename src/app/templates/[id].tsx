// Email template editor — create, edit, delete, and preview before a customer sees it.
//
// Route: /templates/[id]; the id `new` is the create form.
// Backend: GET/PATCH/DELETE /api/v1/email-templates/:id
//          POST             /api/v1/email-templates            (create)
//          GET              /api/v1/email-templates/placeholders
//          POST             /api/v1/email-templates/preview    (unsaved draft, owner/admin)
//          GET              /api/v1/email-templates/:id/preview?contact_id=<uuid>
// i18n:    templates.*
//
// Two things this screen exists to prevent:
//   1. A placeholder typo shipping to a customer — the placeholder catalogue is on screen and
//      insertable, and the preview reports anything it could not resolve.
//   2. A template that reads fine against sample values but breaks on a real record — the
//      preview can be pointed at an actual contact (server-side, through the visibility cone,
//      so this cannot become a way to read a contact outside your branch).
//
// Mutations are owner/admin on the server. For everyone else the fields are read-only and the
// preview falls back to the saved-template route, which is explicitly viewer-safe.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useUserStore } from '../../store/userStore';
import { formatMarketNumber } from '../../market/profile';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';
import { useContactSearch } from '../../hooks/useContactSearch';
import {
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATE_SUBJECT_LENGTH,
  TemplateApiError,
  useDeleteEmailTemplate,
  useEmailTemplate,
  usePreviewEmailTemplate,
  useSaveEmailTemplate,
  useTemplatePlaceholders,
  type TemplatePlaceholder,
} from '../../hooks/useEmailTemplates';

type Selection = { start: number; end: number };
type PlaceholderTarget = 'subject' | 'body';
type PreviewContact = { id: string; name: string };

const EMPTY_SELECTION: Selection = { start: 0, end: 0 };

function contactLabel(first: string, last: string | null, company: string | null): string {
  const name = last === null || last.length === 0 ? first : `${first} ${last}`;
  return company === null || company.length === 0 ? name : `${name} · ${company}`;
}

/** Inserts at the caret, refusing the insert rather than silently truncating past the limit. */
function insertAtSelection(value: string, selection: Selection, token: string, max: number): string {
  const start = Math.min(Math.max(selection.start, 0), value.length);
  const end = Math.min(Math.max(selection.end, start), value.length);
  const next = value.slice(0, start) + token + value.slice(end);
  return next.length > max ? value : next;
}

export default function TemplateEditorScreen(): JSX.Element {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const token = useUserStore((s) => s.token);
  const role = useUserStore((s) => s.user?.role);
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const isNew = id === 'new';
  const templateId = isNew ? null : (id ?? null);
  const canManage = role === 'owner' || role === 'admin';

  const templateQuery = useEmailTemplate(templateId);
  const placeholdersQuery = useTemplatePlaceholders();
  const saveMutation = useSaveEmailTemplate(templateId);
  const deleteMutation = useDeleteEmailTemplate();
  const previewMutation = usePreviewEmailTemplate();

  const [name, setName] = useState<string>('');
  const [subject, setSubject] = useState<string>('');
  const [body, setBody] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const [activeField, setActiveField] = useState<PlaceholderTarget>('body');
  const [subjectSelection, setSubjectSelection] = useState<Selection>(EMPTY_SELECTION);
  const [bodySelection, setBodySelection] = useState<Selection>(EMPTY_SELECTION);

  const [previewContact, setPreviewContact] = useState<PreviewContact | null>(null);
  const [isContactPickerVisible, setIsContactPickerVisible] = useState<boolean>(false);
  const contactSearch = useContactSearch({ token });

  // Hydrate the form once per loaded template — re-running on every render of the query would
  // wipe whatever the user is typing.
  const hydratedIdRef = useRef<string | null>(null);
  const loaded = templateQuery.data?.data;
  if (loaded && hydratedIdRef.current !== loaded.id) {
    hydratedIdRef.current = loaded.id;
    setName(loaded.name);
    setSubject(loaded.subject);
    setBody(loaded.body);
  }

  const insertPlaceholder = useCallback(
    (placeholder: TemplatePlaceholder): void => {
      const marker = `{{${placeholder.key}}}`;
      if (activeField === 'subject') {
        setSubject((current) =>
          insertAtSelection(current, subjectSelection, marker, MAX_TEMPLATE_SUBJECT_LENGTH),
        );
        return;
      }
      setBody((current) => insertAtSelection(current, bodySelection, marker, MAX_TEMPLATE_BODY_LENGTH));
    },
    [activeField, subjectSelection, bodySelection],
  );

  const saveErrorMessage = useMemo((): string | null => {
    const error = saveMutation.error;
    if (!error) return null;
    if (error instanceof TemplateApiError) {
      if (error.code === 'EMAIL_TEMPLATE_LIMIT_REACHED') return t('templates.limitReached');
      if (error.code === 'EMAIL_TEMPLATE_NOT_FOUND') return t('templates.notFound');
      if (error.status === 403) return t('templates.adminOnly');
    }
    return t('templates.failedToSave');
  }, [saveMutation.error, t]);

  const previewErrorMessage = useMemo((): string | null => {
    const error = previewMutation.error;
    if (!error) return null;
    if (error instanceof TemplateApiError) {
      if (error.code === 'CONTACT_NOT_FOUND') return t('templates.previewContactNotFound');
      if (error.status === 403) return t('templates.adminOnly');
    }
    return t('templates.previewFailed');
  }, [previewMutation.error, t]);

  const save = useCallback((): void => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || subject.trim().length === 0 || body.trim().length === 0) {
      setValidationError(t('templates.allFieldsRequired'));
      return;
    }
    setValidationError(null);

    saveMutation.mutate(
      { name: trimmedName, subject, body },
      {
        onSuccess: (envelope) => {
          if (isNew) {
            // Replace, not push: backing out of a just-created template should land on the
            // list, not on the empty create form.
            router.replace({ pathname: '/templates/[id]', params: { id: envelope.data.id } } as never);
          }
        },
      },
    );
  }, [name, subject, body, isNew, saveMutation, t]);

  const confirmDelete = useCallback((): void => {
    if (templateId === null) return;
    Alert.alert(t('templates.deleteConfirmTitle'), t('templates.deleteConfirmBody'), [
      { text: t('templates.cancel'), style: 'cancel' },
      {
        text: t('templates.deleteConfirmAction'),
        style: 'destructive',
        onPress: () => {
          deleteMutation.mutate(templateId, {
            onSuccess: () => router.back(),
            onError: (error) => {
              const message =
                error instanceof TemplateApiError && error.code === 'EMAIL_TEMPLATE_IN_USE'
                  ? t('templates.inUse')
                  : t('templates.failedToDelete');
              Alert.alert(t('templates.deleteConfirmTitle'), message);
            },
          });
        },
      },
    ]);
  }, [templateId, deleteMutation, t]);

  const runPreview = useCallback((): void => {
    previewMutation.mutate({
      templateId,
      subject,
      body,
      contactId: previewContact?.id ?? null,
      // Only owner/admin may render an unsaved draft; a viewer previews what is saved.
      canPreviewDraft: canManage,
    });
  }, [previewMutation, templateId, subject, body, previewContact, canManage]);

  const preview = previewMutation.data;
  const unknownPlaceholders = saveMutation.data?.meta.unknown_placeholders ?? [];
  const isBusy = saveMutation.isPending || deleteMutation.isPending;

  // A saved template that has not been re-fetched yet still needs a title.
  const screenTitle = isNew ? t('templates.newTitle') : (loaded?.name ?? t('templates.title'));

  if (!isNew && templateQuery.isPending) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t('templates.title') }} />
        <ActivityIndicator style={styles.loader} color={colors.orange} />
      </View>
    );
  }

  if (!isNew && templateQuery.isError) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t('templates.title') }} />
        <View style={styles.stateBlock}>
          <Text style={styles.errorText}>
            {templateQuery.error instanceof TemplateApiError &&
            templateQuery.error.code === 'EMAIL_TEMPLATE_NOT_FOUND'
              ? t('templates.notFound')
              : t('templates.failedToLoad')}
          </Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => { void templateQuery.refetch(); }}
            accessibilityRole="button"
          >
            <Text style={styles.retryText}>{t('templates.retry')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: screenTitle }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!canManage ? <Text style={styles.mutedNote}>{t('templates.adminOnly')}</Text> : null}

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('templates.name')}</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            editable={canManage}
            maxLength={MAX_TEMPLATE_NAME_LENGTH}
            placeholder={t('templates.namePlaceholder')}
            placeholderTextColor={colors.placeholder}
          />
          <Text style={styles.fieldHint}>{t('templates.nameHint')}</Text>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('templates.subject')}</Text>
          <TextInput
            style={[styles.input, activeField === 'subject' ? styles.inputActive : null]}
            value={subject}
            onChangeText={setSubject}
            onFocus={() => setActiveField('subject')}
            onSelectionChange={(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) =>
              setSubjectSelection(e.nativeEvent.selection)
            }
            editable={canManage}
            maxLength={MAX_TEMPLATE_SUBJECT_LENGTH}
            placeholder={t('templates.subjectPlaceholder')}
            placeholderTextColor={colors.placeholder}
          />
          <Text style={styles.counter}>
            {formatMarketNumber(subject.length)} / {formatMarketNumber(MAX_TEMPLATE_SUBJECT_LENGTH)}
          </Text>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>{t('templates.body')}</Text>
          <TextInput
            style={[styles.bodyInput, activeField === 'body' ? styles.inputActive : null]}
            value={body}
            onChangeText={setBody}
            onFocus={() => setActiveField('body')}
            onSelectionChange={(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) =>
              setBodySelection(e.nativeEvent.selection)
            }
            editable={canManage}
            maxLength={MAX_TEMPLATE_BODY_LENGTH}
            multiline
            textAlignVertical="top"
            placeholder={t('templates.bodyPlaceholder')}
            placeholderTextColor={colors.placeholder}
          />
          <Text style={styles.counter}>
            {formatMarketNumber(body.length)} / {formatMarketNumber(MAX_TEMPLATE_BODY_LENGTH)}
          </Text>
        </View>

        {/* Placeholder catalogue — what the author is allowed to insert. */}
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>{t('templates.placeholders')}</Text>
          <Text style={styles.panelHint}>{t('templates.placeholdersHint')}</Text>
          {canManage ? (
            <Text style={styles.panelHint}>
              {t('templates.insertInto', {
                field: activeField === 'subject' ? t('templates.subject') : t('templates.body'),
              })}
            </Text>
          ) : null}

          {placeholdersQuery.isPending ? (
            <ActivityIndicator color={colors.orange} style={styles.panelLoader} />
          ) : placeholdersQuery.isError ? (
            <Text style={styles.errorText}>{t('templates.placeholdersFailed')}</Text>
          ) : (
            <View style={styles.chips}>
              {(placeholdersQuery.data ?? []).map((placeholder) => (
                <TouchableOpacity
                  key={placeholder.key}
                  style={styles.chip}
                  onPress={() => insertPlaceholder(placeholder)}
                  disabled={!canManage}
                  accessibilityRole="button"
                  accessibilityLabel={`{{${placeholder.key}}}`}
                  activeOpacity={0.7}
                >
                  <Text style={styles.chipText}>{`{{${placeholder.key}}}`}</Text>
                  <Text style={styles.chipExample} numberOfLines={1}>
                    {t('templates.placeholderExample', { value: placeholder.example })}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Preview — the last chance to catch a mistake before a customer reads it. */}
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>{t('templates.preview')}</Text>
          <Text style={styles.panelHint}>{t('templates.previewHint')}</Text>

          <View style={styles.previewTargetRow}>
            <View style={styles.previewTargetInfo}>
              <Text style={styles.previewTargetLabel}>{t('templates.previewTarget')}</Text>
              <Text style={styles.previewTargetValue} numberOfLines={1}>
                {previewContact === null ? t('templates.previewSample') : previewContact.name}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.linkButton}
              onPress={() => setIsContactPickerVisible(true)}
              accessibilityRole="button"
            >
              <Text style={styles.linkButtonText}>{t('templates.chooseContact')}</Text>
            </TouchableOpacity>
          </View>
          {previewContact !== null ? (
            <TouchableOpacity
              style={styles.linkButton}
              onPress={() => setPreviewContact(null)}
              accessibilityRole="button"
            >
              <Text style={styles.linkButtonText}>{t('templates.useSampleValues')}</Text>
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={runPreview}
            disabled={previewMutation.isPending || (!canManage && templateId === null)}
            accessibilityRole="button"
            activeOpacity={0.7}
          >
            {previewMutation.isPending ? (
              <ActivityIndicator color={colors.orange} />
            ) : (
              <Text style={styles.secondaryButtonText}>{t('templates.runPreview')}</Text>
            )}
          </TouchableOpacity>

          {previewErrorMessage !== null ? (
            <Text style={styles.errorText}>{previewErrorMessage}</Text>
          ) : null}

          {preview ? (
            <View style={styles.previewResult}>
              <Text style={styles.previewMeta}>
                {preview.meta.sample
                  ? t('templates.previewSampleNote')
                  : t('templates.previewContactNote', { name: previewContact?.name ?? '' })}
              </Text>
              <Text style={styles.previewFieldLabel}>{t('templates.subject')}</Text>
              <Text style={styles.previewValue}>{preview.data.subject}</Text>
              <Text style={styles.previewFieldLabel}>{t('templates.body')}</Text>
              <Text style={styles.previewValue}>{preview.data.text}</Text>
              {preview.data.unresolved.length > 0 ? (
                <Text style={styles.warningText}>
                  {t('templates.unresolved', { list: preview.data.unresolved.join(', ') })}
                </Text>
              ) : null}
              {preview.data.blank.length > 0 ? (
                <Text style={styles.warningText}>
                  {t('templates.blank', { list: preview.data.blank.join(', ') })}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>

        {validationError !== null ? <Text style={styles.errorText}>{validationError}</Text> : null}
        {saveErrorMessage !== null ? <Text style={styles.errorText}>{saveErrorMessage}</Text> : null}
        {saveMutation.isSuccess && unknownPlaceholders.length > 0 ? (
          <Text style={styles.warningText}>
            {t('templates.unresolved', { list: unknownPlaceholders.join(', ') })}
          </Text>
        ) : null}
        {saveMutation.isSuccess && !isNew ? (
          <Text style={styles.savedText}>{t('templates.saved')}</Text>
        ) : null}

        {canManage ? (
          <>
            <TouchableOpacity
              style={[styles.primaryButton, isBusy ? styles.buttonDisabled : null]}
              onPress={save}
              disabled={isBusy}
              accessibilityRole="button"
              activeOpacity={0.8}
            >
              {saveMutation.isPending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>{t('templates.save')}</Text>
              )}
            </TouchableOpacity>

            {!isNew ? (
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={confirmDelete}
                disabled={isBusy}
                accessibilityRole="button"
              >
                <Text style={styles.deleteButtonText}>{t('templates.delete')}</Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <Modal
        visible={isContactPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsContactPickerVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('templates.chooseContact')}</Text>
            <Text style={styles.panelHint}>{t('templates.chooseContactHint')}</Text>
            <TextInput
              style={styles.input}
              value={contactSearch.query}
              onChangeText={contactSearch.setQuery}
              placeholder={t('templates.searchContact')}
              placeholderTextColor={colors.placeholder}
              autoCorrect={false}
              autoFocus
            />
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {contactSearch.results.length === 0 ? (
                <Text style={styles.panelHint}>{t('templates.noContacts')}</Text>
              ) : (
                contactSearch.results.map((contact) => (
                  <TouchableOpacity
                    key={contact.id}
                    style={styles.contactRow}
                    onPress={() => {
                      setPreviewContact({
                        id: contact.id,
                        name: contactLabel(contact.first_name, contact.last_name, contact.company),
                      });
                      previewMutation.reset();
                      contactSearch.clearResults();
                      setIsContactPickerVisible(false);
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.contactName}>
                      {contactLabel(contact.first_name, contact.last_name, contact.company)}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setIsContactPickerVisible(false)}
              accessibilityRole="button"
            >
              <Text style={styles.modalCloseText}>{t('templates.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, paddingBottom: 40 },
  loader: { marginTop: 32 },
  stateBlock: { padding: 16, gap: 10, alignItems: 'flex-start' },
  mutedNote: { fontSize: 12, color: c.textMuted, lineHeight: 17, marginBottom: 12 },
  fieldGroup: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '600', color: c.text1, marginBottom: 4 },
  fieldHint: { fontSize: 12, color: c.textMuted, marginTop: 4, lineHeight: 16 },
  counter: { fontSize: 11, color: c.textMuted, marginTop: 4, textAlign: 'right' },
  input: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    fontSize: 15,
    color: c.text1,
  },
  bodyInput: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    height: 200,
    fontSize: 15,
    lineHeight: 21,
    color: c.text1,
  },
  inputActive: { borderColor: c.orange },
  panel: {
    backgroundColor: c.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
    marginBottom: 16,
    gap: 6,
  },
  panelTitle: { fontSize: 14, fontWeight: '700', color: c.orange },
  panelHint: { fontSize: 12, color: c.amber, lineHeight: 17 },
  panelLoader: { marginVertical: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  chip: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
    maxWidth: '100%',
  },
  chipText: { fontSize: 13, fontWeight: '700', color: c.text1 },
  chipExample: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  previewTargetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 6,
  },
  previewTargetInfo: { flex: 1 },
  previewTargetLabel: { fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  previewTargetValue: { fontSize: 14, color: c.text1, fontWeight: '600', marginTop: 2 },
  linkButton: { paddingVertical: 8, alignSelf: 'flex-start' },
  linkButtonText: { fontSize: 13, color: c.orange, fontWeight: '700' },
  secondaryButton: {
    marginTop: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.orange,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: c.orange, fontSize: 14, fontWeight: '700' },
  previewResult: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: 10,
    gap: 4,
  },
  previewMeta: { fontSize: 12, color: c.amber, marginBottom: 4 },
  previewFieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: c.amber,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
  },
  previewValue: { fontSize: 14, color: c.text1, lineHeight: 20 },
  warningText: { fontSize: 12, color: c.red, lineHeight: 17, marginTop: 8 },
  savedText: { fontSize: 13, color: c.orange, marginBottom: 8 },
  errorText: { fontSize: 13, color: c.red, lineHeight: 18, marginTop: 6 },
  retryButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: c.orange,
    borderRadius: 6,
  },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  primaryButton: {
    backgroundColor: c.orange,
    borderRadius: 12,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  buttonDisabled: { opacity: 0.7 },
  deleteButton: { marginTop: 12, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  deleteButtonText: { color: c.red, fontSize: 15, fontWeight: '600' },
  modalBackdrop: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: c.bgPanel,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '80%',
    gap: 8,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: c.text1 },
  modalScroll: { marginTop: 4 },
  contactRow: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border },
  contactName: { fontSize: 15, color: c.text1 },
  modalClose: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 20 },
  modalCloseText: { color: c.orange, fontSize: 14, fontWeight: '700' },
});
