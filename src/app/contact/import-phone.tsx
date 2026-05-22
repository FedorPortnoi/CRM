import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Contacts from 'expo-contacts';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react-native';
import { useUserStore } from '../../store/userStore';
import { API_URL } from '../../utils/api';

type Phase = 'permission' | 'loading' | 'list' | 'importing';

type PhoneContact = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  displayName: string;
};

type Progress = {
  done: number;
  total: number;
};

type ContactCreateBody = {
  first_name: string;
  last_name?: string;
  phone?: string;
  email?: string;
};

type UserStoreTokenState = {
  token: string | null;
};

function mapToPhoneContact(contact: Contacts.ExistingContact): PhoneContact {
  const id: string = contact.id;
  const firstName: string = contact.firstName ?? '';
  const lastName: string = contact.lastName ?? '';
  const phone: string | null = contact.phoneNumbers?.[0]?.number?.trim() ?? null;
  const email: string | null = contact.emails?.[0]?.email?.trim() ?? null;
  const trimmedName: string = contact.name?.trim() ?? '';
  const fallbackName: string = [firstName, lastName]
    .filter((namePart: string): boolean => namePart.length > 0)
    .join(' ');
  let displayName: string = 'Unknown';

  if (trimmedName.length > 0) {
    displayName = trimmedName;
  } else if (fallbackName.length > 0) {
    displayName = fallbackName;
  } else if (phone !== null && phone.length > 0) {
    displayName = phone;
  } else if (email !== null && email.length > 0) {
    displayName = email;
  }

  return {
    id,
    firstName,
    lastName,
    phone,
    email,
    displayName,
  };
}

function buildContactBody(contact: PhoneContact): ContactCreateBody {
  const displayNameParts: string[] = contact.displayName.split(' ');
  const displayNameIsFallback = contact.displayName === contact.phone || contact.displayName === contact.email;
  const firstName: string = contact.firstName || (!displayNameIsFallback ? displayNameParts[0] : '') || 'Unknown';
  const lastName: string | null = contact.lastName
    ? contact.lastName
    : !displayNameIsFallback && contact.displayName.includes(' ')
      ? displayNameParts.slice(1).join(' ')
      : null;
  const body: ContactCreateBody = { first_name: firstName };

  if (lastName !== null && lastName.length > 0) {
    body.last_name = lastName;
  }
  if (contact.phone !== null && contact.phone.length > 0) {
    body.phone = contact.phone;
  }
  if (contact.email !== null && contact.email.length > 0 && contact.email.includes('@')) {
    body.email = contact.email;
  }

  return body;
}

export default function ImportPhoneContactsScreen(): React.ReactElement {
  const { t } = useTranslation();
  const token: string | null = useUserStore((state: UserStoreTokenState): string | null => state.token);
  const [phase, setPhase] = useState<Phase>('permission');
  const [isRequestingPermission, setIsRequestingPermission] = useState<boolean>(true);
  const [permissionDenied, setPermissionDenied] = useState<boolean>(false);
  const [canAskContactsPermissionAgain, setCanAskContactsPermissionAgain] = useState<boolean>(true);
  const [deviceContacts, setDeviceContacts] = useState<PhoneContact[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState<string>('');
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0 });

  const requestContactsPermission = useCallback(async (): Promise<void> => {
    setIsRequestingPermission(true);
    setPermissionDenied(false);

    try {
      const permissionResponse: Contacts.PermissionResponse = await Contacts.requestPermissionsAsync();
      if (permissionResponse.status === Contacts.PermissionStatus.GRANTED) {
        setCanAskContactsPermissionAgain(true);
        setPhase('loading');
      } else {
        setCanAskContactsPermissionAgain(permissionResponse.canAskAgain !== false);
        setPermissionDenied(true);
      }
    } catch {
      setCanAskContactsPermissionAgain(false);
      setPermissionDenied(true);
    } finally {
      setIsRequestingPermission(false);
    }
  }, []);

  const loadDeviceContacts = useCallback(async (): Promise<void> => {
    try {
      const contactResponse: Contacts.ContactResponse = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
      });
      const mappedContacts: PhoneContact[] = contactResponse.data
        .map((contact: Contacts.ExistingContact): PhoneContact => mapToPhoneContact(contact))
        .filter(
          (contact: PhoneContact): boolean =>
            !(contact.displayName === 'Unknown' && contact.phone === null && contact.email === null),
        );

      setDeviceContacts(mappedContacts);
    } catch {
      setDeviceContacts([]);
    } finally {
      setPhase('list');
    }
  }, []);

  useEffect((): void => {
    void requestContactsPermission();
  }, [requestContactsPermission]);

  useEffect((): void => {
    if (phase === 'loading') {
      void loadDeviceContacts();
    }
  }, [loadDeviceContacts, phase]);

  const filteredContacts: PhoneContact[] = useMemo((): PhoneContact[] => {
    const query: string = search.trim().toLowerCase();

    if (query.length === 0) {
      return deviceContacts;
    }

    return deviceContacts.filter((contact: PhoneContact): boolean => {
      const searchableText: string = `${contact.displayName} ${contact.phone ?? ''}`.toLowerCase();
      return searchableText.includes(query);
    });
  }, [deviceContacts, search]);

  const handleSearchChange = useCallback((nextSearch: string): void => {
    setSearch(nextSearch);
  }, []);

  const toggleSelection = useCallback((id: string): void => {
    setSelectedIds((currentSelectedIds: string[]): string[] => {
      if (currentSelectedIds.includes(id)) {
        return currentSelectedIds.filter((selectedId: string): boolean => selectedId !== id);
      }

      return [...currentSelectedIds, id];
    });
  }, []);

  const importSelectedContacts = useCallback(async (): Promise<void> => {
    const selectedContacts: PhoneContact[] = deviceContacts.filter((contact: PhoneContact): boolean =>
      selectedIds.includes(contact.id),
    );
    const total: number = selectedIds.length;

    if (total === 0) {
      return;
    }

    setProgress({ done: 0, total });
    setPhase('importing');

    let importedCount: number = 0;
    let failedCount: number = 0;
    let completedCount: number = 0;

    for (let contactIndex: number = 0; contactIndex < selectedContacts.length; contactIndex += 1) {
      const contact: PhoneContact = selectedContacts[contactIndex];
      const body: ContactCreateBody = buildContactBody(contact);

      try {
        const response: Response = await fetch(`${API_URL}/contacts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          importedCount += 1;
        } else {
          failedCount += 1;
        }
      } catch {
        failedCount += 1;
      } finally {
        completedCount += 1;
        setProgress({ done: completedCount, total });
      }
    }

    const message: string =
      importedCount > 0 && failedCount === 0
        ? `${importedCount} contact(s) imported successfully`
        : importedCount > 0
          ? `${importedCount} imported, ${failedCount} failed`
          : 'No contacts were imported';

    Alert.alert('Import Complete', message, [
      {
        text: 'OK',
        onPress: (): void => {
          router.push('/(tabs)/contacts');
        },
      },
    ]);
  }, [deviceContacts, selectedIds, token]);

  const keyExtractor = useCallback((item: PhoneContact): string => item.id, []);

  const renderContactRow = useCallback(
    ({ item }: { item: PhoneContact }): React.ReactElement => {
      const isSelected: boolean = selectedIds.includes(item.id);
      const subtitle: string = item.phone || item.email || '';

      return (
        <TouchableOpacity
          style={styles.contactRow}
          onPress={() => {
            toggleSelection(item.id);
          }}
          accessibilityRole="button"
          accessibilityState={{ selected: isSelected }}
        >
          <View style={styles.checkboxArea}>
            <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
              {isSelected ? <Check size={16} color="#FFFFFF" /> : null}
            </View>
          </View>
          <View style={styles.contactTextArea}>
            <Text style={styles.contactName}>{item.displayName}</Text>
            {subtitle.length > 0 ? <Text style={styles.contactSubtitle}>{subtitle}</Text> : null}
          </View>
        </TouchableOpacity>
      );
    },
    [selectedIds, toggleSelection],
  );

  if (phase === 'permission') {
    if (isRequestingPermission || !permissionDenied) {
      return (
        <View style={styles.centeredContainer}>
          <ActivityIndicator size="large" color="#10b981" />
        </View>
      );
    }

    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.errorText}>Contacts access is required to import from your phone.</Text>
        <TouchableOpacity
          style={styles.settingsButton}
          onPress={() => {
            if (canAskContactsPermissionAgain) {
              void requestContactsPermission();
            } else {
              void Linking.openSettings();
            }
          }}
          accessibilityRole="button"
        >
          <Text style={styles.settingsButtonText}>
            {canAskContactsPermissionAgain ? 'Try Again' : 'Open Settings'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'loading') {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  if (phase === 'importing') {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator size="large" color="#10b981" />
        <Text style={styles.progressText}>
          Importing {progress.done} of {progress.total}...
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={handleSearchChange}
          placeholder={t('contacts.searchImportPhone')}
          placeholderTextColor="#9ca3af"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <FlatList<PhoneContact>
        data={filteredContacts}
        keyExtractor={keyExtractor}
        renderItem={renderContactRow}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={
          filteredContacts.length === 0 ? styles.emptyListContent : styles.listContent
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>No contacts found</Text>
          </View>
        }
      />
      <View style={styles.actionBar}>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={() => {
            router.back();
          }}
          accessibilityRole="button"
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.importButton,
            selectedIds.length === 0 ? styles.importButtonDisabled : null,
          ]}
          onPress={() => {
            void importSelectedContacts();
          }}
          disabled={selectedIds.length === 0}
          accessibilityRole="button"
        >
          <Text style={styles.importButtonText}>Import ({selectedIds.length})</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0fdf8',
  },
  centeredContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#f0fdf8',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 16,
    textAlign: 'center',
  },
  settingsButton: {
    minHeight: 44,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#10b981',
  },
  settingsButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  progressText: {
    marginTop: 16,
    color: '#111827',
    fontSize: 16,
    fontWeight: '600',
  },
  searchContainer: {
    padding: 16,
    backgroundColor: '#f0fdf8',
  },
  searchInput: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    color: '#111827',
    fontSize: 16,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  emptyListContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyStateText: {
    color: '#6b7280',
    fontSize: 16,
  },
  contactRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  checkboxArea: {
    width: 36,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  checkbox: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#10b981',
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
  checkboxSelected: {
    backgroundColor: '#10b981',
  },
  contactTextArea: {
    flex: 1,
  },
  contactName: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '700',
  },
  contactSubtitle: {
    marginTop: 2,
    color: '#6b7280',
    fontSize: 14,
  },
  actionBar: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    backgroundColor: '#FFFFFF',
  },
  cancelButton: {
    minHeight: 44,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  cancelButtonText: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '600',
  },
  importButton: {
    minHeight: 44,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#10b981',
  },
  importButtonDisabled: {
    opacity: 0.5,
  },
  importButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
