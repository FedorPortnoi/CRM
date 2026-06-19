import { Text } from 'react-native';
import FileImportScreen, { rowStyles } from './FileImportScreen';

interface VContact { first_name: string; last_name?: string; phone?: string; email?: string; company?: string }

function parseVCards(text: string): VContact[] {
  return text.split(/BEGIN:VCARD/i).slice(1).map((block) => {
    const get = (f: string) => block.match(new RegExp(`^${f}[^:]*:(.+)$`, 'im'))?.[1]?.trim();
    const fn = get('FN'); const n = get('N');
    let first = '', last = '';
    if (fn) { const p = fn.split(' '); first = p[0]; last = p.slice(1).join(' '); }
    else if (n) { const p = n.split(';'); last = p[0]?.trim(); first = p[1]?.trim(); }
    return { first_name: first || 'Контакт', last_name: last || undefined, phone: get('TEL')?.replace(/\s/g, ''), email: get('EMAIL'), company: get('ORG') };
  }).filter((c) => c.first_name !== 'Контакт' || c.phone);
}

export default function VCardImportScreen() {
  return (
    <FileImportScreen<VContact>
      mimeTypes={['text/vcard', 'text/x-vcard', '*/*']}
      accentColor="#8B5CF6"
      parse={parseVCards}
      endpoint="/import/vcard"
      getKey={(_item, index) => String(index)}
      pickTitle="Файл контактов"
      pickInstructions="Файл .vcf из iPhone, Google, Outlook или любого другого приложения"
      pickButtonLabel="Выбрать .vcf файл"
      emptyError="Контакты не найдены — нужен файл .vcf"
      renderItem={(item) => {
        const name = [item.first_name, item.last_name].filter(Boolean).join(' ');
        const sub = [item.phone, item.email, item.company].filter(Boolean).join(' · ');
        return (
          <>
            <Text style={rowStyles.rowName}>{name}</Text>
            {sub ? <Text style={rowStyles.rowSub}>{sub}</Text> : null}
          </>
        );
      }}
    />
  );
}
