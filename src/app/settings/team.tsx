import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, Modal, TextInput, ListRenderItemInfo,
  Share, Clipboard, ScrollView,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';
import { useTheme } from '../../hooks/useTheme';
import { ThemeColors } from '../../theme';

/**
 * Mirrors backend/services/capabilities.ts. The backend is authoritative — it
 * refuses anything this list gets wrong — but the two must be edited together
 * when a role is added, or the picker silently omits it.
 */
type Role =
  | 'owner'
  | 'admin'
  | 'head'
  | 'member'
  | 'accountant'
  | 'marketer'
  | 'support'
  | 'viewer';

interface OrgMember {
  id: string;
  email: string | null;
  username: string | null;
  name: string;
  role: Role;
  manager_id: string | null;
}

/** A minted, unredeemed invite. The link itself is NOT part of this shape — the
 *  backend never stores it in plaintext, so the list can show everything about
 *  an invite except the one thing that would let the owner resend it. */
interface PendingInvite {
  id: string;
  name: string;
  role: Role;
  expires_at: string;
  opened_at: string | null;
  created_at: string;
}

/** The single moment the link exists on this device. Held in state, never
 *  persisted, and dropped when the sheet closes. */
interface CreatedInvite {
  name: string;
  role: Role;
  url: string;
}

// Blue marks the account that owns the org; warm tones mark everyone who can
// change data; muted grey marks the roles that can only look.
const ROLE_COLORS: Record<Role, string> = {
  owner: '#3b82f6',
  admin: '#CC785C',
  head: '#CC785C',
  member: '#D4A27F',
  marketer: '#D4A27F',
  support: '#D4A27F',
  accountant: '#8FA3AD',
  viewer: '#8FA3AD',
};

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  head: 'Руководитель отдела',
  member: 'Менеджер',
  accountant: 'Бухгалтер',
  marketer: 'Маркетолог',
  support: 'Поддержка',
  viewer: 'Только просмотр',
};

/** One line each, so the picker explains the choice instead of just naming it. */
const ROLE_HINTS: Record<Role, string> = {
  owner: 'Полный доступ, включая передачу владения',
  admin: 'Полный доступ, кроме назначения администраторов',
  head: 'Как менеджер, плюс данные своих подчинённых',
  member: 'Свои контакты, сделки и задачи',
  accountant: 'Видит все деньги и выгрузки. Не может ничего менять',
  marketer: 'Рассылки и шаблоны по всей базе. Без правки сделок',
  support: 'Контакты и активность. Без воронки и сумм',
  viewer: 'Видит свои данные. Не может ничего менять',
};

// `admin` is offered only to an owner; the backend enforces the same rule via
// the team.manage_admins capability, so a tampered client gains nothing.
const ASSIGNABLE_ROLES: Role[] = ['head', 'member', 'accountant', 'marketer', 'support', 'viewer'];

/** Russian needs three forms and the invite window is short enough that the
 *  count is genuinely variable, so «через 21 час» / «через 22 часа» / «через 5
 *  часов» all occur in normal use. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** An invite lives 24 hours, so a date tells the owner nothing — the whole
 *  lifetime fits inside «сегодня». Hours, then minutes at the end. */
function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'срок истёк';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `истекает через ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `истекает через ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;
}

/** Hand-built rather than toLocaleTimeString: Hermes ships only a partial Intl
 *  and the options form is not dependable across the two platforms. */
function formatOpenedAt(openedAt: string): string {
  const d = new Date(openedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.toLocaleDateString('ru-RU')} в ${hh}:${mm}`;
}

export default function TeamScreen(): JSX.Element {
  const token = useUserStore((s) => s.token);
  const currentUser = useUserStore((s) => s.user);
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  // Read here, not inside the Modal: a full-screen Modal draws over the status
  // bar, and the insets the navigator reports for this screen are the ones the
  // modal header needs to clear it.
  const insets = useSafeAreaInsets();

  const canManage = currentUser?.role === 'owner' || currentUser?.role === 'admin';
  const isOwner = currentUser?.role === 'owner';

  // `/settings/team?add=1` (the Создать sheet shortcut) lands with the form
  // already open. Read once into initial state rather than in an effect, so it
  // does not reopen every time the param is still in the URL after a close.
  const { add } = useLocalSearchParams<{ add?: string }>();
  const [showInviteModal, setShowInviteModal] = useState(add === '1');
  // One field, because the backend takes one `name` and derives the username
  // from it. Splitting it here would only re-join it in the request body.
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');

  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  // Whether the link has been put anywhere it survives the sheet closing.
  // Guards the exit, because closing without this is unrecoverable.
  const [linkSaved, setLinkSaved] = useState(false);

  const { data: members = [], isLoading, error } = useQuery<OrgMember[]>({
    queryKey: ['org-users', token],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/users`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Не удалось загрузить команду');
      const json = (await res.json()) as { data: OrgMember[] };
      return json.data;
    },
    enabled: !!token,
  });

  // Endpoint is gated on team.manage, so asking as a member would only earn a
  // 403 and a spurious error card.
  const { data: invites = [], error: invitesError } = useQuery<PendingInvite[]>({
    queryKey: ['invites', token],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/auth/invites`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Не удалось загрузить приглашения');
      const json = (await res.json()) as { data: PendingInvite[] };
      return json.data;
    },
    enabled: !!token && canManage,
  });

  const inviteMutation = useMutation({
    mutationFn: async (data: { name: string; role: Role }) => {
      const res = await fetch(`${API_URL}/auth/invites`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = (await res.json()) as {
        data: { id: string; name: string; role: Role; expires_at: string; created_at: string; invite_url: string };
        error?: { message: string };
      };
      if (!res.ok) throw new Error(json.error?.message ?? 'Не удалось создать приглашение');
      return json.data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['invites'] });
      setShowInviteModal(false);
      // `invite_url` arrives in this response and nowhere else, ever. Straight
      // into state and onto the screen — there is no second chance to fetch it.
      setLinkSaved(false);
      setCreatedInvite({ name: data.name, role: data.role, url: data.invite_url });
      setInviteName(''); setInviteRole('member');
    },
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  const revokeInviteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${API_URL}/auth/invites/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message: string } };
        throw new Error(json.error?.message ?? 'Не удалось отозвать приглашение');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['invites'] }),
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${API_URL}/auth/users/${id}/deactivate`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message: string } };
        throw new Error(json.error?.message ?? 'Не удалось деактивировать');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['org-users'] }),
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  const roleMutation = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: Role }) => {
      const res = await fetch(`${API_URL}/auth/users/${id}/role`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message: string } };
        throw new Error(json.error?.message ?? 'Не удалось изменить роль');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['org-users'] }),
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  const managerMutation = useMutation({
    mutationFn: async ({ id, manager_id }: { id: string; manager_id: string | null }) => {
      const res = await fetch(`${API_URL}/auth/users/${id}/manager`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manager_id }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message: string } };
        throw new Error(json.error?.message ?? 'Не удалось назначить руководителя');
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['org-users'] }),
    onError: (e: Error) => Alert.alert('Ошибка', e.message),
  });

  // Only an owner may hand out `admin`. The backend enforces the same rule, so
  // this is presentation, not protection.
  const offeredRoles: Role[] = isOwner ? ['admin', ...ASSIGNABLE_ROLES] : ASSIGNABLE_ROLES;

  // Every way out of the invite form — header arrow, «Отмена», Android hardware
  // back — funnels through here so the three cannot drift apart.
  const closeInviteModal = useCallback(() => setShowInviteModal(false), []);

  const dismissLink = useCallback(() => {
    setCreatedInvite(null);
    setLinkSaved(false);
  }, []);

  // The one destructive close in this screen that leaves no trace: the link is
  // not stored anywhere, so «Готово» before copying it silently wastes the
  // invite. Android hardware back lands here too.
  const requestCloseLink = useCallback(() => {
    if (linkSaved) { dismissLink(); return; }
    Alert.alert(
      'Закрыть без ссылки?',
      'Ссылку больше не показать. Придётся создать новое приглашение.',
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Закрыть', style: 'destructive', onPress: dismissLink },
      ],
    );
  }, [linkSaved, dismissLink]);

  const copyLink = useCallback(() => {
    if (!createdInvite) return;
    Clipboard.setString(createdInvite.url);
    setLinkSaved(true);
    Alert.alert('Скопировано');
  }, [createdInvite]);

  const shareLink = useCallback(async () => {
    if (!createdInvite) return;
    try {
      const result = await Share.share({
        message: `Привет, ${createdInvite.name}! Тебя пригласили в 4КУБ.\n\nОткрой ссылку на телефоне — она сама приведёт к приложению и подставит приглашение:\n${createdInvite.url}\n\nСсылка действует 24 часа, потом перестанет работать.`,
      });
      // iOS reports an explicit dismissal. Keep the close warning armed in
      // that case because this is the only screen that can ever show the URL.
      if (result.action === Share.sharedAction) {
        setLinkSaved(true);
      }
    } catch {
      Alert.alert('Не удалось поделиться', 'Скопируйте ссылку и отправьте её вручную.');
    }
  }, [createdInvite]);

  const confirmRevokeInvite = useCallback((invite: PendingInvite) => {
    Alert.alert('Отозвать приглашение', `Ссылка для ${invite.name} перестанет работать. Продолжить?`, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Отозвать', style: 'destructive', onPress: () => revokeInviteMutation.mutate(invite.id) },
    ]);
  }, [revokeInviteMutation]);

  const confirmDeactivate = useCallback((member: OrgMember) => {
    Alert.alert('Удалить доступ', `Убрать ${member.name} из команды?`, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => deactivateMutation.mutate(member.id) },
    ]);
  }, [deactivateMutation]);

  const promptRoleChange = useCallback((member: OrgMember) => {
    Alert.alert('Изменить роль', `Выберите роль для ${member.name}`, offeredRoles.map((r) => ({
      text: ROLE_LABELS[r],
      onPress: () => roleMutation.mutate({ id: member.id, role: r }),
    })).concat([{ text: 'Отмена', onPress: () => undefined }]));
  }, [roleMutation, offeredRoles]);

  const promptManagerChange = useCallback((member: OrgMember, allMembers: OrgMember[]) => {
    const eligibleManagers = allMembers.filter((m) => m.id !== member.id);
    const options = eligibleManagers.map((m) => ({
      text: m.name,
      onPress: () => managerMutation.mutate({ id: member.id, manager_id: m.id }),
    }));
    options.push({ text: 'Без руководителя', onPress: () => managerMutation.mutate({ id: member.id, manager_id: null }) });
    options.push({ text: 'Отмена', onPress: () => undefined });
    Alert.alert('Руководитель', `Выберите руководителя для ${member.name}`, options);
  }, [managerMutation]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<OrgMember>) => {
    const isSelf = item.id === currentUser?.id;
    const managerName = item.manager_id ? (members.find((m) => m.id === item.manager_id)?.name ?? null) : null;
    return (
      <View style={styles.row}>
        <View style={[styles.avatar, { backgroundColor: ROLE_COLORS[item.role] }]}>
          <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.rowInfo}>
          <Text style={styles.rowName}>{item.name}{isSelf ? ' (вы)' : ''}</Text>
          <Text style={styles.rowEmail}>{item.email ?? item.username ?? ''}</Text>
          {managerName !== null ? (
            <Text style={styles.rowManager}>↑ {managerName}</Text>
          ) : null}
        </View>
        <View style={[styles.badge, { backgroundColor: ROLE_COLORS[item.role] + '22' }]}>
          <Text style={[styles.badgeText, { color: ROLE_COLORS[item.role] }]}>{ROLE_LABELS[item.role]}</Text>
        </View>
        {canManage && !isSelf && item.role !== 'owner' && (
          <View style={styles.actions}>
            {isOwner && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => promptRoleChange(item)}>
                <Text style={styles.actionBtnText}>Роль</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.actionBtn} onPress={() => promptManagerChange(item, members)}>
              <Text style={styles.actionBtnText}>Рук-ль</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, styles.deactivateBtn]} onPress={() => confirmDeactivate(item)}>
              <Text style={[styles.actionBtnText, { color: colors.red }]}>Убрать</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }, [canManage, isOwner, currentUser?.id, members, confirmDeactivate, promptRoleChange, promptManagerChange, styles, colors.red]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Команда', headerBackTitle: 'Настройки' }} />
      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.orange} />
      ) : error ? (
        <Text style={styles.errorText}>{(error as Error).message}</Text>
      ) : (
        <FlatList
          data={members}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View>
              {/* Only what is still redeemable: the backend filters out consumed,
                  revoked and expired invites, so an empty list means nothing is
                  outstanding and the card can disappear entirely. */}
              {canManage && (invites.length > 0 || invitesError) && (
                <View style={styles.pendingCard}>
                  <Text style={styles.codeLabel}>Приглашения по ссылке</Text>
                  {invitesError ? (
                    <Text style={styles.pendingError}>{(invitesError as Error).message}</Text>
                  ) : (
                    <>
                      {invites.map((invite) => (
                        <View key={invite.id} style={styles.pendingRow}>
                          <View style={styles.rowInfo}>
                            <Text style={styles.rowName}>{invite.name}</Text>
                            <Text style={styles.pendingMeta}>
                              {ROLE_LABELS[invite.role]} · {formatRemaining(invite.expires_at)}
                            </Text>
                            {invite.opened_at ? (
                              <Text style={styles.pendingOpened}>Ссылку открыли {formatOpenedAt(invite.opened_at)}</Text>
                            ) : (
                              <Text style={styles.pendingWaiting}>Ссылку ещё не открывали</Text>
                            )}
                          </View>
                          <TouchableOpacity
                            style={[styles.actionBtn, styles.deactivateBtn]}
                            onPress={() => confirmRevokeInvite(invite)}
                            disabled={revokeInviteMutation.isPending}
                          >
                            <Text style={[styles.actionBtnText, { color: colors.red }]}>Отозвать</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                      <Text style={styles.codeHint}>
                        Саму ссылку видно только в момент создания. Если она потерялась — отзовите приглашение и создайте новое.
                      </Text>
                    </>
                  )}
                </View>
              )}
              <Text style={styles.count}>{members.length} {members.length === 1 ? 'участник' : 'участников'}</Text>
            </View>
          }
        />
      )}
      {canManage && (
        <TouchableOpacity style={styles.inviteButton} onPress={() => setShowInviteModal(true)}>
          <Text style={styles.inviteButtonText}>+ Добавить сотрудника</Text>
        </TouchableOpacity>
      )}

      <Modal visible={createdInvite !== null} animationType="fade" transparent onRequestClose={requestCloseLink}>
        <View style={styles.credOverlay}>
          <View style={styles.credCard}>
            <Text style={styles.credTitle}>Ссылка готова</Text>
            <Text style={styles.credSubtitle}>
              Отправьте её <Text style={{ fontWeight: '700' }}>{createdInvite?.name}</Text>
              {createdInvite ? ` — по ссылке сотрудник сам создаст аккаунт с ролью «${ROLE_LABELS[createdInvite.role]}».` : ''}
            </Text>

            <View style={styles.linkBox}>
              <Text style={styles.linkValue} selectable>{createdInvite?.url}</Text>
            </View>

            <Text style={styles.linkWarn}>
              Ссылка показывается только один раз — мы её не храним. Если закрыть окно, не сохранив ссылку, придётся создать новое приглашение.
            </Text>
            <Text style={styles.credHint}>Ссылка действует 24 часа и открывает доступ одному человеку.</Text>

            <TouchableOpacity style={styles.linkShare} onPress={shareLink}>
              <Text style={styles.linkShareText}>Поделиться</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.linkCopy} onPress={copyLink}>
              <Text style={styles.linkCopyText}>Копировать</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.credDone} onPress={requestCloseLink}>
              <Text style={styles.credDoneText}>Готово</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showInviteModal} animationType="slide" onRequestClose={closeInviteModal}>
        <View style={styles.modal}>
          {/*
            A full-screen Modal covers the navigator, taking the global NavHeader
            — and with it the only back arrow — off screen. NavHeader itself is
            not reusable here: its arrow is route-driven (router.back()), which
            would abandon the team screen rather than dismiss this form. So this
            repeats NavHeader's geometry (52pt row, 26px arrow, 18/700 title) and
            wires it to the modal instead.
          */}
          <View style={[styles.modalHeader, { paddingTop: insets.top }]}>
            <View style={styles.modalHeaderRow}>
              <TouchableOpacity
                onPress={closeInviteModal}
                style={styles.modalBackBtn}
                accessibilityRole="button"
                accessibilityLabel="Назад"
                hitSlop={8}
              >
                <ArrowLeft size={26} color={colors.text1} strokeWidth={2.4} />
              </TouchableOpacity>
              <Text style={styles.modalHeaderTitle} numberOfLines={1}>Добавить сотрудника</Text>
            </View>
          </View>
          {/* Up to seven role cards plus the name field overflow a small screen,
              which would otherwise strand «Создать ссылку» below the fold. */}
          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalIntro}>
              Вы получите ссылку-приглашение. Отправьте её сотруднику — по ней он установит приложение и сам заведёт себе логин и пароль.
            </Text>
            <Text style={styles.label}>Имя сотрудника</Text>
            <TextInput
              style={styles.input}
              value={inviteName}
              onChangeText={setInviteName}
              placeholder="Иван Петров"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="words"
            />
            <Text style={styles.inputHint}>Имя и фамилия одной строкой — так сотрудник будет подписан в команде.</Text>
            <Text style={styles.label}>Роль</Text>
            <View style={styles.roleList}>
              {offeredRoles.map((r) => (
                <TouchableOpacity
                  key={r}
                  style={[styles.roleOption, inviteRole === r && styles.roleOptionSelected]}
                  onPress={() => setInviteRole(r)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: inviteRole === r }}
                >
                  <View style={[styles.roleDot, { backgroundColor: ROLE_COLORS[r] }]} />
                  <View style={styles.roleOptionText}>
                    <Text style={[styles.rolePillText, inviteRole === r && styles.rolePillTextSelected]}>{ROLE_LABELS[r]}</Text>
                    <Text style={styles.roleHint}>{ROLE_HINTS[r]}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={[styles.inviteButton, { marginTop: 24 }]}
              onPress={() => inviteMutation.mutate({ name: inviteName.trim(), role: inviteRole })}
              disabled={inviteMutation.isPending || !inviteName.trim()}
            >
              <Text style={styles.inviteButtonText}>{inviteMutation.isPending ? 'Создание…' : 'Создать ссылку'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={closeInviteModal}>
              <Text style={styles.cancelBtnText}>Отмена</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 80 },
  count: { fontSize: 13, color: c.amber, marginBottom: 12 },
  codeLabel: { fontSize: 12, fontWeight: '600', color: c.amber, textTransform: 'uppercase', letterSpacing: 0.5 },
  codeHint: { fontSize: 12, color: c.amber, marginTop: 8, lineHeight: 17 },
  pendingCard: { backgroundColor: c.bgPanel, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.border },
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  pendingMeta: { fontSize: 12, color: c.amber, marginTop: 2 },
  pendingOpened: { fontSize: 11, color: c.orange, marginTop: 2 },
  pendingWaiting: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  pendingError: { fontSize: 13, color: c.red, marginTop: 10, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.bgPanel, borderRadius: 10, padding: 12, marginBottom: 8, gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '600', color: c.text1 },
  rowEmail: { fontSize: 12, color: c.amber, marginTop: 2 },
  rowManager: { fontSize: 11, color: c.orange, marginTop: 2 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 6 },
  actionBtn: { borderRadius: 6, borderWidth: 1, borderColor: c.border, paddingHorizontal: 8, paddingVertical: 4 },
  deactivateBtn: { borderColor: 'rgba(204,82,71,0.12)' },
  actionBtnText: { fontSize: 12, color: c.text1 },
  errorText: { color: c.red, textAlign: 'center', marginTop: 40, paddingHorizontal: 24 },
  inviteButton: { margin: 16, backgroundColor: c.orange, borderRadius: 10, padding: 14, alignItems: 'center' },
  inviteButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  modal: { flex: 1, backgroundColor: c.bg },
  // Kept numerically in step with NavHeader so the form reads as a pushed
  // screen rather than a stray sheet; change these only alongside that file.
  modalHeader: { backgroundColor: c.bgDark, borderBottomWidth: 1, borderBottomColor: c.border },
  modalHeaderRow: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  modalBackBtn: { padding: 8 },
  modalHeaderTitle: { fontSize: 18, fontWeight: '700', color: c.text1, marginLeft: 4, flex: 1 },
  modalBody: { padding: 24, paddingBottom: 48 },
  modalIntro: { fontSize: 13, color: c.amber, lineHeight: 19 },
  label: { fontSize: 13, fontWeight: '600', color: c.text1, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: c.inputBg, borderRadius: 8, borderWidth: 1, borderColor: c.inputBorder, padding: 12, fontSize: 15, color: c.text1 },
  inputHint: { fontSize: 12, color: c.textMuted, marginTop: 6, lineHeight: 16 },
  roleRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  roleList: { gap: 8 },
  roleOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgPanel,
  },
  roleOptionSelected: { borderColor: c.orange, backgroundColor: c.orange },
  roleOptionText: { flex: 1 },
  roleDot: { width: 10, height: 10, borderRadius: 5 },
  roleHint: { fontSize: 12, color: c.textMuted, marginTop: 2, lineHeight: 16 },
  rolePill: { borderRadius: 20, borderWidth: 1, borderColor: c.border, paddingHorizontal: 14, paddingVertical: 6 },
  rolePillSelected: { backgroundColor: c.orange, borderColor: c.orange },
  rolePillText: { fontSize: 13, color: c.text1 },
  rolePillTextSelected: { color: '#fff', fontWeight: '600' },
  cancelBtn: { marginTop: 12, alignItems: 'center', padding: 12 },
  cancelBtnText: { color: c.amber, fontSize: 15 },
  credOverlay: { flex: 1, backgroundColor: c.overlay, justifyContent: 'center', padding: 24 },
  credCard: { backgroundColor: c.bgPanel, borderRadius: 16, padding: 24 },
  credTitle: { fontSize: 20, fontWeight: '700', color: c.text1, marginBottom: 8 },
  credSubtitle: { fontSize: 14, color: c.amber, marginBottom: 20, lineHeight: 20 },
  credHint: { fontSize: 12, color: c.textMuted, marginTop: 8, lineHeight: 17 },
  credDone: { marginTop: 10, alignItems: 'center', padding: 12 },
  credDoneText: { color: c.amber, fontSize: 15 },
  // The URL wraps rather than truncating: an owner who reads it aloud or
  // screenshots it needs all of it, and an ellipsis would hide the token.
  linkBox: { backgroundColor: c.bg, borderRadius: 8, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 10 },
  linkValue: { fontSize: 13, color: c.text1, fontWeight: '600', lineHeight: 19 },
  linkWarn: { fontSize: 12, color: c.red, marginTop: 12, lineHeight: 17 },
  linkShare: { marginTop: 20, backgroundColor: c.orange, borderRadius: 10, padding: 16, alignItems: 'center' },
  linkShareText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  linkCopy: { marginTop: 10, borderRadius: 10, borderWidth: 1, borderColor: c.borderStrong, padding: 14, alignItems: 'center' },
  linkCopyText: { color: c.text1, fontWeight: '600', fontSize: 15 },
});
