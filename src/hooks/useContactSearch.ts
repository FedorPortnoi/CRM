import { useState, useEffect } from 'react';
import { API_URL } from '../utils/api';

interface ContactPreview {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
}

interface ContactSearchResult {
  data: ContactPreview[];
}

interface UseContactSearchOptions {
  token: string | null;
  debounceMs?: number;
  minLength?: number;
  perPage?: number;
}

interface UseContactSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  results: ContactPreview[];
  clearResults: () => void;
}

export function useContactSearch({
  token,
  debounceMs = 300,
  minLength = 2,
  perPage = 8,
}: UseContactSearchOptions): UseContactSearchReturn {
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<ContactPreview[]>([]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (query.trim().length >= minLength) {
        try {
          const res = await fetch(
            `${API_URL}/contacts?q=${encodeURIComponent(query.trim())}&per_page=${perPage}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const json = (await res.json()) as ContactSearchResult;
          setResults(json.data);
        } catch {
          setResults([]);
        }
      } else {
        setResults([]);
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [query, token, debounceMs, minLength, perPage]);

  const clearResults = (): void => {
    setResults([]);
    setQuery('');
  };

  return { query, setQuery, results, clearResults };
}
