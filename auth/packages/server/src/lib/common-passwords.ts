/**
 * Most common passwords from public breach corpora that are long enough to pass the length
 * check. The breach check (HIBP) catches the long tail; this list is an offline backstop.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '1234567890', '12345678910', '123456789a', '1234567890a', '0123456789', '0987654321', '1111111111',
  '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4t5', 'qwertyuiop', 'qwertyuiop123', 'qwerty12345', 'qwerty123456',
  'qwerty1234', 'qwertyuiop1', 'asdfghjkl1', 'asdfghjkl123', 'zxcvbnm123', '1qaz2wsx3edc', 'zaq12wsxcde3',
  'password12', 'password123', 'password1234', 'password12345', 'password!1', 'password1!', 'passw0rd123',
  'p@ssw0rd123', 'p@ssword123', 'password2024', 'password2025', 'password2026', 'mypassword', 'mypassword1',
  'iloveyou12', 'iloveyou123', 'princess123', 'football123', 'baseball123', 'sunshine123', 'superman123',
  'starwars123', 'welcome123', 'welcome1234', 'letmein123', 'trustno1234', 'dragon1234', 'monkey12345',
  'master12345', 'shadow12345', 'michael123', 'jennifer123', 'computer123', 'whatever123', 'administrator',
  'admin12345', 'admin123456', 'changeme123', 'changeme1234', 'default1234', 'abcdefghij', 'abcdefg123',
  'abc1234567', 'abcd123456', 'a123456789', 'aa12345678', 'q123456789', 'qazwsxedcrfv', 'qazwsx123456',
  '987654321a', 'iloveyou1234', 'chocolate1', 'pokemon1234', 'liverpool1', 'liverpool123', 'chelsea123',
  'arsenal123', 'manchester1', 'basketball', 'basketball1', 'basketball123', 'football12', 'soccer1234',
  'jordan2323', 'blink18218', 'charlie123', 'thomas1234', 'hannah1234', 'samantha123', 'elizabeth1',
  'christopher', 'christopher1', 'jessica123', 'nicole1234', 'daniel1234', 'matthew123', 'anthony123',
  'qwerty123!', 'qwertyqwerty', 'asdasdasd1', 'asdfasdfasdf', 'zxcvbnmasdf', 'internet123', 'samsung123',
  'google1234', 'facebook123', 'linkedin123', 'spotify123', 'minecraft1', 'minecraft123', 'fortnite123',
  'starwars1', 'pass123456', 'pass12345678', 'test123456', 'testing123', 'test12345678', 'secret1234',
  'secret12345', 'welcome2024', 'welcome2025', 'welcome2026', 'summer2024', 'summer2025', 'summer2026',
  'winter2024', 'winter2025', 'winter2026', 'spring2025', 'autumn2025', 'letmein1234', 'login12345',
  'user123456', 'access1234', 'freedom123', 'trustno1!!', 'hello12345', 'hello123456', 'helloworld',
  'helloworld1', 'helloworld123', 'iloveu1234', 'lovelove12', 'loveyou123', 'babygirl12', 'babygirl123',
  'princess12', 'sunshine12', 'butterfly1', 'butterfly123', 'flower1234', 'rainbow1234', 'purple1234',
  'superman12', 'batman1234', 'spiderman1', 'spiderman123', 'pokemon123', 'naruto1234', 'dragonball',
  'trinity123', 'matrix1234', 'computer12', 'laptop1234', 'iphone1234', 'samsung1234', 'apple12345',
  'monkey1234', 'tigger1234', 'killer1234', 'hunter1234', 'ranger1234', 'buster1234', 'soccer12345',
]);
