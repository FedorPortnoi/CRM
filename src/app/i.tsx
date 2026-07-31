/**
 * The route the invite LINK actually lands on.
 *
 * The link is `https://4kub.ru/i#<token>` — short because it gets pasted into
 * messengers, and `/i` is what the App Link intent filter and the
 * apple-app-site-association both bind to (see app.json and
 * website/.well-known/). expo-router maps a URL path to a file of the same name,
 * so without this file a verified deep link would open the app to a 404 while
 * the screen sat at `/invite`, unreachable from the outside.
 *
 * Kept as a shim rather than renaming InviteScreen's route, so `/invite` stays
 * available as a plain in-app destination — the manual-code path needs somewhere
 * to live that was not opened by a link.
 */
import InviteScreen from '../screens/InviteScreen';

export default InviteScreen;
