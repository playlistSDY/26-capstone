import { test, expect } from '@playwright/test';
import { mockBackend } from './backend-fixture';

test('999 quantities fit, persist and reach checkout; the counter cannot add a 1000th cup',async({page})=>{
 const backend=await mockBackend(page,{autoPrint:true});
 await page.clock.install();
 await page.goto('/?kiosk=1');
 await page.evaluate(()=>localStorage.setItem('switch.kiosk.draft.v1',JSON.stringify({place:'takeout',lines:[{
   id:'quantity-limit',productId:'vanilla',quantity:998,
   options:{temperature:'ice',size:'regular',shots:0,syrup:0,milk:'regular',ice:'normal',sweetness:'normal',decaf:false,whippedCream:'normal'},
 }]})));
 await page.reload();
 const add=page.getByRole('button',{name:'바닐라라떼 주문 수량 늘리기',exact:true});
 await add.click();await expect(add).toBeDisabled();
 await expect(page.locator('strong[aria-label="바닐라라떼 주문 수량"]')).toHaveText('999');
 for(const [width,height] of [[1600,2560],[1280,800]]){
  await page.setViewportSize({width,height});
  const rect=await page.locator('.dock-line').evaluate(el=>{
   const money=el.querySelector(':scope > b')!.getBoundingClientRect();
   const counter=el.querySelector('.counter')!.getBoundingClientRect();
   const remove=el.querySelector('.dock-delete')!.getBoundingClientRect();
   return {moneyRight:money.right,removeLeft:remove.left,counterRight:counter.right,moneyLeft:money.left};
  });
  expect(rect.moneyRight).toBeLessThanOrEqual(rect.removeLeft+1);
  expect(rect.counterRight).toBeLessThanOrEqual(rect.moneyLeft+1);
 }
 await page.getByRole('button',{name:'결제하기',exact:true}).click();
 await page.getByRole('button',{name:'바닐라라떼 옵션 변경',exact:true}).click();
 await expect(page.getByRole('button',{name:'메뉴 수량 늘리기',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'4,495,500원 수정하기',exact:true}).click();
 await page.reload();
 await page.getByRole('button',{name:'결제하기',exact:true}).click();
 await expect(page.getByRole('button',{name:'바닐라라떼 수량 늘리기',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'확인하고 결제하기',exact:true}).click();
 await page.getByRole('button',{name:'신용·체크카드',exact:true}).click();
 await page.getByRole('button',{name:'결제 리더기',exact:true}).click();
 await page.clock.runFor(5000);
 await expect.poll(()=>backend.jobs.length).toBe(1);
 const doc=backend.jobs[0].document as {items:{quantity:number}[],quantity:number,total:number};
 expect(doc.items[0].quantity).toBe(999);expect(doc.quantity).toBe(999);expect(doc.total).toBe(4495500);
});
