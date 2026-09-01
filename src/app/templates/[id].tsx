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
import { AlertCircle } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { formatMarketNumber } from '../../market/profile';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors, spacing, radius, type, tabular } from '../../theme';
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
import { Card, Button, EmptyState, Skeleton, SkeletonText } from '../../components/ui';

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
        <View style={styles.content}>
          <Card>
            <Skeleton width="50%" height={16} style={styles.skeletonGap} />
            <Skeleton width="100%" height={44} rounded={radius.lg} style={styles.skeletonGap} />
            <Skeleton width="100%" height={44} rounded={radius.lg} />
          </Card>
          <Card style={styles.cardGap}>
            <SkeletonText lines={4} lastLineWidth="70%" />
          </Card>
        </View>
      </View>
    );
  }

  if (!isNew && templateQuery.isError) {
    const notFound =
      templateQuery.error instanceof TemplateApiError &&
      templateQuery.error.code === 'EMAIL_TEMPLATE_NOT_FOUND';
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: t('templates.title') }} />
        <EmptyState
          icon={<AlertCircle size={32} color={colors.danger} />}
          title={notFound ? t('templates.notFound') : t('templates.failedToLoad')}
          actionLabel={notFound ? undefined : t('templates.retry')}
          onAction={notFound ? undefined : () => { void templateQuery.refetch(); }}
        />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
        <Card style={styles.panel}>
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
            <View style={styles.chips}>
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} width={92} height={40} rounded={radius.md} />
              ))}
            </View>
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
        </Card>

        {/* Preview — the last chance to catch a mistake before a customer reads it. */}
        <Card style={styles.panel}>
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
              activeOpacity={0.7}
            >
              <Text style={styles.linkButtonText}>{t('templates.chooseContact')}</Text>
            </TouchableOpacity>
          </View>
          {previewContact !== null ? (
            <TouchableOpacity
              style={styles.linkButton}
              onPress={() => setPreviewContact(null)}
              accessibilityRole="button"
              activeOpacity={0.7}
            >
              <Text style={styles.linkButtonText}>{t('templates.useSampleValues')}</Text>
            </TouchableOpacity>
          ) : null}

          <Button
            title={t('templates.runPreview')}
            onPress={runPreview}
            variant="secondary"
            loading={previewMutation.isPending}
            disabled={!canManage && templateId === null}
            style={styles.previewButton}
          />

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
        </Card>

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
            <Button
              title={t('templates.save')}
              onPress={save}
              loading={saveMutation.isPending}
              disabled={isBusy}
              block
              style={styles.submitButton}
            />

            {!isNew ? (
              <Button
                title={t('templates.delete')}
                onPress={confirmDelete}
                variant="danger"
                loading={deleteMutation.isPending}
                disabled={isBusy}
                block
                style={styles.deleteButton}
              />
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
                    activeOpacity={0.7}
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
              activeOpacity={0.7}
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
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  skeletonGap: { marginBottom: spacing.sm },
  cardGap: { marginTop: spacing.lg },
  mutedNote: { ...type.caption, color: c.textMuted, marginBottom: spacing.lg },
  fieldGroup: { marginBottom: spacing.lg },
  label: { ...type.label, color: c.text1, marginBottom: spacing.xs },
  fieldHint: { ...type.caption, color: c.textMuted, marginTop: spacing.xs },
  counter: { ...type.micro, color: c.textMuted, marginTop: spacing.xs, textAlign: 'right', ...tabular },
  input: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...type.body,
    color: c.text1,
  },
  bodyInput: {
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    height: 200,
    ...type.body,
    color: c.text1,
  },
  inputActive: { borderColor: c.accent },
  panel: { gap: spacing.sm, marginBottom: spacing.lg },
  panelTitle: { ...type.heading, color: c.accent },
  panelHint: { ...type.caption, color: c.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  chip: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.borderStrong,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    maxWidth: '100%',
  },
  chipText: { ...type.label, color: c.text1 },
  chipExample: { ...type.micro, color: c.textMuted, marginTop: spacing.xs },
  previewTargetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  previewTargetInfo: { flex: 1 },
  previewTargetLabel: { ...type.micro, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  previewTargetValue: { ...type.body, color: c.text1, marginTop: spacing.xs },
  linkButton: { paddingVertical: spacing.sm, alignSelf: 'flex-start' },
  linkButtonText: { ...type.label, color: c.accent },
  previewButton: { marginTop: spacing.xs, alignSelf: 'stretch' },
  previewResult: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: spacing.md,
    gap: spacing.xs,
  },
  previewMeta: { ...type.caption, color: c.textMuted, marginBottom: spacing.xs },
  previewFieldLabel: {
    ...type.micro,
    color: c.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.sm,
  },
  previewValue: { ...type.body, color: c.text1 },
  warningText: { ...type.label, color: c.danger, marginTop: spacing.sm },
  savedText: { ...type.label, color: c.accent, marginBottom: spacing.sm },
  errorText: { ...type.label, color: c.danger, marginTop: spacing.xs },
  submitButton: { marginTop: spacing.lg },
  deleteButton: { marginTop: spacing.md },
  modalBackdrop: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: c.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.xl,
    maxHeight: '80%',
    gap: spacing.sm,
  },
  modalTitle: { ...type.subtitle, color: c.text1 },
  modalScroll: { marginTop: spacing.xs },
  contactRow: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: c.border },
  contactName: { ...type.body, color: c.text1 },
  modalClose: { alignSelf: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.xl },
  modalCloseText: { ...type.label, color: c.accent },
});
