import { test, expect } from '@playwright/test';

test('profile email is editable, offered when adding a pane, and never claims Google login is verified', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /브라우저 프로필/ }).click();
  await page.getByLabel('프로필 이름', { exact: true }).fill('브랜드 A');
  await expect(page.getByLabel('Google 이메일 (선택)', { exact: true })).toBeVisible();
  await page.getByLabel('Google 이메일 (선택)', { exact: true }).fill('brand-a@example.com');
  await page.getByRole('button', { name: '프로필 만들기', exact: true }).click();
  await page.getByRole('button', { name: '브랜드 A 프로필 수정', exact: true }).click();
  await page.getByLabel('Google 이메일 (선택)', { exact: true }).fill('updated@example.com');
  await page.getByRole('button', { name: '프로필 저장', exact: true }).click();
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  await page.getByRole('button', { name: '화면 추가', exact: true }).click();
  await expect(page.getByRole('button', { name: /브랜드 A.*updated@example.com/ })).toBeVisible();
  await expect(
    page.getByText('같은 프로필이어도 화면마다 로그인 상태가 따로 유지됩니다.'),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /브라우저 프로필/ }).click();
  await expect(page.getByText('updated@example.com', { exact: true })).toBeVisible();
  await expect(page.getByText('Google 연결 완료', { exact: true })).toHaveCount(0);
});
