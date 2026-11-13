// These scripts run in an untrusted page. They expose no Node or shell APIs.
export const selectorFunction = `e => {
  const parts=[];
  while(e&&e!==document.body){
    if(e.id&&document.querySelectorAll('#'+CSS.escape(e.id)).length===1){parts.unshift('#'+CSS.escape(e.id));return parts.join(' > ');}
    let i=1,s=e;while((s=s.previousElementSibling))if(s.tagName===e.tagName)i++;
    parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+i+')');e=e.parentElement;
  }
  return parts.length?'body > '+parts.join(' > '):'body';
}`;

export const readScrollScript = `(() => {
  const selector=${selectorFunction};
  const containers=[];
  for(const e of Array.from(document.querySelectorAll('body, body *')).slice(0,4000)){
    if(containers.length>=80)break;
    if(e===document.scrollingElement)continue;
    if(e.clientHeight===0||e.clientWidth===0)continue;
    if(e.scrollHeight<=e.clientHeight&&e.scrollWidth<=e.clientWidth)continue;
    const s=getComputedStyle(e);
    if(!/(auto|scroll|overlay)/.test(s.overflowY+' '+s.overflowX))continue;
    const path=selector(e);if(path.length<=4096)containers.push({selector:path,x:e.scrollLeft,y:e.scrollTop});
  }
  return {x:scrollX,y:scrollY,containers};
})()`;

export function restoreScrollScript(position) {
  const clean = {
    x: Number.isFinite(position.x) ? position.x : 0,
    y: Number.isFinite(position.y) ? position.y : 0,
    containers: Array.isArray(position.containers)
      ? position.containers
          .slice(0, 80)
          .filter(
            (item) =>
              typeof item.selector === 'string' &&
              item.selector.length <= 4096 &&
              Number.isFinite(item.x) &&
              Number.isFinite(item.y),
          )
      : [],
  };
  return `new Promise(resolve=>requestAnimationFrame(()=>{
    const position=${JSON.stringify(clean)};
    window.scrollTo({left:position.x,top:position.y,behavior:'instant'});
    for(const item of position.containers){try{document.querySelector(item.selector)?.scrollTo({left:item.x,top:item.y,behavior:'instant'});}catch{}}
    resolve();
  }))`;
}

export function scrollPageScript({ selector, x = 0, y = 0 }) {
  return `(() => {
    const selector=${JSON.stringify(selector || null)},x=${Number(x)},y=${Number(y)};
    let target=selector?document.querySelector(selector):document.elementFromPoint(innerWidth/2,innerHeight/2);
    if(selector&&!target)throw new Error('스크롤할 요소를 찾을 수 없어요.');
    if(!selector){
      while(target&&target!==document.scrollingElement){
        const s=getComputedStyle(target);
        if((y&&target.scrollHeight>target.clientHeight&&/(auto|scroll|overlay)/.test(s.overflowY))||(x&&target.scrollWidth>target.clientWidth&&/(auto|scroll|overlay)/.test(s.overflowX)))break;
        target=target.parentElement;
      }
    }
    if(!target||target===document.scrollingElement)window.scrollBy({left:x,top:y,behavior:'instant'});
    else target.scrollBy({left:x,top:y,behavior:'instant'});
  })()`;
}
