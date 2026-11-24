#!/usr/bin/env python3
"""将线路分期任务书编译到线路数据；默认 dry-run，歧义时阻止 apply。"""
import argparse, datetime, hashlib, json, pathlib, shutil

DEFAULT = pathlib.Path(r'C:/Users/18916/Documents/远期图测试')
RANK = {'existing': 0, 'approved': 1, 'future': 2}
ROUTES = {
'1号线':[('莘庄','富锦路','existing'),('莘庄','莘建东路','approved')],
'2号线':[('蟠祥路·国家会计学院','上海东站','existing'),('浦东1号2号航站楼','浦东3号航站楼','approved')],
'3号线':[('上海南站','江杨北路','existing')],'4号线':[('全线',None,'existing')],
'5号线':[('莘庄','奉贤新城','existing')],'6号线':[('东方体育中心','港城路','existing')],
'7号线':[('花木路','美兰湖','existing')],'8号线':[('沈杜公路','市光路','existing')],
'9号线':[('曹路','上海松江站','existing')],
'10号线':[('虹桥火车站','基隆路','existing')],
'11号线':[('嘉定北','迪士尼','existing')],
'12号线':[('金海路','七莘路','existing'),('七莘路','洞泾','approved')],
'13号线':[('金运路','张江路','existing'),('张江路','丹桂路','approved'),('金运路','前湾公园','approved')],
'14号线':[('封浜','桂桥路','existing')],
'15号线':[('顾村公园','紫竹高新区','existing'),('紫竹高新区','望园路','approved')],
'16号线':[('龙阳路','滴水湖','existing')],'17号线':[('西岑','虹桥火车站','existing')],
'18号线':[('康文路','航头','existing')],'19号线':[('虹建路','上海宝山站','approved')],
'20号线':[('交通路','高东东','approved')],'21号线':[('东靖路','浦东3号航站楼','approved')],
'22号线':[('金吉路','裕安','approved')],
'23号线':[('东川路','闵行开发区','existing'),('上海体育馆','东川路','approved')],
'29号线':[('前湾公园','国际会展中心','approved')],
'奉贤线':[('三林南','海湾大学城','approved')],'嘉闵线':[('太仓','旗忠网球中心','approved')],
'南枫线':[('全线',None,'approved')],'浦南线':[('上海科技馆','国际创新协同区','approved')],
'南汇线':[('全线',None,'approved')],
'机场联络线':[('浦东1号2号航站楼','虹桥2号航站楼','existing')],
'机场快线':[('龙阳路','浦东1号2号航站楼','existing')],
'金山线':[('上海南站','金山卫','existing')],'苏淀沪线':[('全线',None,'approved')],
}

def fingerprint(root):
 h=hashlib.sha256()
 for p in sorted(x for x in root.rglob('*') if x.is_file()):
  rel=p.relative_to(root).as_posix().encode(); b=p.read_bytes()
  h.update(len(rel).to_bytes(8,'big')); h.update(rel); h.update(len(b).to_bytes(8,'big')); h.update(b)
 return h.hexdigest()

def sections_for(statuses, oldsecs, oldseg):
 n=len(statuses); boundaries={0,n}
 if isinstance(oldseg,list) and len(oldseg)==n:
  boundaries.update(i for i in range(1,n) if oldseg[i]!=oldseg[i-1])
 cuts=sorted(boundaries); secs=[]; seg=[0]*n
 for a,b in zip(cuts,cuts[1:]):
  oi=oldseg[a] if a<n and isinstance(oldseg,list) and len(oldseg)==n else None
  old=oldsecs[oi] if isinstance(oi,int) and isinstance(oldsecs,list) and 0<=oi<len(oldsecs) else {}
  i=a
  while i<b:
   j=i+1
   while j<b and statuses[j]==statuses[i]: j+=1
   secs.append({'name':old.get('name','') or '', 'status':statuses[i]})
   for k in range(i,j): seg[k]=len(secs)-1
   i=j
 return secs,seg

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--data',type=pathlib.Path,default=DEFAULT); ap.add_argument('--apply',action='store_true'); a=ap.parse_args()
 root=a.data.resolve(); paths=sorted((root/'lines').glob('*.json'))
 if not paths: raise SystemExit(f'线路目录为空：{root / "lines"}')
 before=fingerprint(root); docs={p.name:json.loads(p.read_text(encoding='utf-8-sig')) for p in paths}; byid={d['id']:d for d in docs.values()}; pathid={d['id']:p for p,d in zip(paths,docs.values())}
 gp=root/'groups.json'; groups=json.loads(gp.read_text(encoding='utf-8-sig')); issues=[]; plan={}; changed={}
 def locate(d,name):
  # 用户确认的任务书别名，仅用于本次区间定位，不改 stop.name。
  aliases={'23号线':{'上海体育馆':'上海体育场'},'29号线':{'国际会展中心':'国家会展中心'}}
  lookup=aliases.get(d.get('name'),{}).get(name,name)
  hits=[i for i,s in enumerate(d.get('stops',[])) if s.get('name')==lookup]
  if len(hits)!=1:
   candidates='；'.join(f"{i}:{s.get('id')}「{s.get('name','')}」" for i,s in enumerate(d.get('stops',[])))
   issues.append(f"{d['id']} {d['name']}：端点「{name}」匹配{len(hits)}个；全线候选站序：{candidates}")
   return None
  return hits[0]
 def cover(d,arr,start,end,state):
  ss=d.get('stops',[]); n=len(ss)
  if start=='全线': return [state]*(n if d.get('loop') else max(0,n-1))
  i,j=locate(d,start),locate(d,end)
  if i is None or j is None:return arr
  if i==j: issues.append(f"{d['id']} {d['name']}：区间端点重合于{i}:{ss[i].get('id')}「{start}」"); return arr
  step=1 if i<j else -1
  for k in range(i,j,step): arr[k if step>0 else k-1]=state
  return arr
 # All local non-connector routes default future. Preserve out-of-province and archived lines.
 for d in docs.values():
  if d.get('meta',{}).get('archived') or d.get('meta',{}).get('layer')=='他省': continue
  if d.get('role')=='connector' or d.get('meta',{}).get('layer')=='联络线': continue
  n=len(d.get('stops',[])); edges=n if d.get('loop') else max(0,n-1)
  if edges==0: plan[d['id']]=None; continue
  arr=['future']*edges
  if d.get('groupId')=='lg05': arr=['approved']*edges
  elif d.get('name')=='示范区线': arr=['approved']*edges  # legacy groupId fallback for main entity.
  else:
   route=ROUTES.get(d.get('name'),[])
   if d.get('groupId')=='lg02' and d.get('role')=='branch':
    # Both 10号线 branches are explicitly included by 航中路/虹桥火车站.
    arr=['existing']*edges
   elif d.get('groupId')=='lg03' and d.get('role')=='branch':
    route=[('花桥','嘉定新城','existing')]
   for x,y,state in route: arr=cover(d,arr,x,y,state)
  plan[d['id']]=arr
 # 23/29 taskbook aliases are user-confirmed for this migration lookup only.
 # locate() uses each alias only when it uniquely resolves; stop.name remains unchanged.
 # 示范区排除段：identify its endpoints by unique names and traverse groupId=lg05 plus existing groups.
 demo=[d for d in docs.values() if d.get('groupId')=='lg05' and not d.get('meta',{}).get('archived') and d.get('meta',{}).get('layer')!='他省']
 if demo:
  ends=[]
  for name in ('前湾公园','中山公园'):
   hits=[s['id'] for d in demo for s in d.get('stops',[]) if s.get('name')==name]
   if len(hits)!=1:
    issues.append(f"示范区端点「{name}」在 lg05 线路拓扑匹配{len(hits)}个：{hits}"); ends=[]; break
   ends.append(hits[0])
  if ends:
   adj={}; edge={}; stopline={s['id']:d for d in docs.values() for s in d.get('stops',[])}
   for d in demo:
    ss=d.get('stops',[])
    for i in range(len(ss)-1):
     u,v=ss[i]['id'],ss[i+1]['id']; adj.setdefault(u,set()).add(v); adj.setdefault(v,set()).add(u); edge[frozenset((u,v))]=(d,i)
    if d.get('loop') and len(ss)>1:
     u,v=ss[-1]['id'],ss[0]['id']; adj.setdefault(u,set()).add(v); adj.setdefault(v,set()).add(u); edge[frozenset((u,v))]=(d,len(ss)-1)
   for g in groups.get('stationGroups',[]):
    ids=[x for x in g.get('stops',[]) if x in stopline and stopline[x] in demo]
    for i,u in enumerate(ids):
     for v in ids[i+1:]: adj.setdefault(u,set()).add(v); adj.setdefault(v,set()).add(u)
   src,dst=ends; prev={src:None}; ways={src:1}; q=[src]
   for u in q:
    for v in adj.get(u,()):
     if v not in prev: prev[v]=u; ways[v]=ways[u]; q.append(v)
     elif prev[u]!=v: ways[v]=min(2,ways.get(v,0)+ways[u])
   if dst not in prev or ways.get(dst)!=1: issues.append(f"示范区前湾公园—中山公园路径不唯一或不存在：最短路径数={ways.get(dst,0)}")
   else:
    nodes=[]; u=dst
    while u is not None: nodes.append(u); u=prev[u]
    for u,v in zip(nodes,nodes[1:]):
     e=edge.get(frozenset((u,v)))
     if e: plan[e[0]['id']][e[1]]='future'
 # User-confirmed reserved stops affect only stop.status.
 for d in docs.values():
  if d.get('meta',{}).get('archived') or d.get('meta',{}).get('layer')=='他省': continue
  for s in d.get('stops',[]):
   if (d.get('name'),s.get('name')) in {('14号线','龙居路'),('金山线','金山科创中心')} and s.get('status')!='future': s['status']='future'
 # Connector endpoint classification only through a station group and its declared connects.
 idx={s['id']:(d,i) for d in docs.values() for i,s in enumerate(d.get('stops',[]))}; sg={sid:g for g in groups.get('stationGroups',[]) for sid in g.get('stops',[])}
 for d in docs.values():
  if d.get('meta',{}).get('archived') or d.get('meta',{}).get('layer')=='他省':continue
  if d.get('role')!='connector' and d.get('meta',{}).get('layer')!='联络线':continue
  stops=d.get('stops',[])
  if not stops:
   issues.append(f"{d['id']} {d['name']} 零站联络线：未发现可由 connects={d.get('connects',[])} 唯一验证的 path 端点投影；拒绝静默漏分期")
   continue
  states=[]
  for s in stops:
   g=sg.get(s['id']); cand=[]
   if g:
    for sid in g.get('stops',[]):
     if sid==s['id'] or sid not in idx:continue
     host,i=idx[sid]
     if host['id'] not in d.get('connects',[]):continue
     ar=plan.get(host['id'])
     if ar is not None:
      inc=([ar[i-1]] if i>0 else [])+([ar[i]] if i<len(ar) else [])
      if inc:cand.append((host['id'],max(inc,key=RANK.get)))
   hostids={x[0] for x in cand}
   if len(hostids)!=1:
    issues.append(f"{d['id']} {d['name']} 联络端点 {s['id']}「{s.get('name','')}」接入线候选={sorted(hostids)}；connects={d.get('connects',[])}")
   else: states.append(max((x[1] for x in cand),key=RANK.get))
  if len(states)==len(stops):plan[d['id']]=[max(states,key=RANK.get)]*max(0,len(stops)-1)
 # Apply plan to in-memory documents; preserve old sections and names, splitting only as needed.
 for ident,arr in plan.items():
  d=byid[ident]
  if arr is None:
   if d.get('status')!='future':d['status']='future'; changed[pathid[ident]]=d
   continue
  secs,seg=sections_for(arr,d.get('sections'),d.get('segments'))
  if d.get('sections')!=secs or d.get('segments')!=seg or d.get('status') is not None:
   d['sections']=secs;d['segments']=seg;d['status']=None;changed[pathid[ident]]=d
 for d in docs.values():
  if any(s.get('status')=='future' and (d.get('name'),s.get('name')) in {('14号线','龙居路'),('金山线','金山科创中心')} for s in d.get('stops',[])):
   if any(json.loads(pathid[d['id']].read_text(encoding='utf-8-sig'))['stops'][i].get('status')!='future' for i,s in enumerate(d.get('stops',[])) if (d.get('name'),s.get('name')) in {('14号线','龙居路'),('金山线','金山科创中心')}):changed[pathid[d['id']]]=d
 print(f"DRY-RUN：{len(changed)} 个线路文件拟变化；歧义 {len(issues)} 项；未写入。")
 for p,d in sorted(changed.items()):print(f"变更 {d['id']} {d['name']}")
 for x in issues:print('歧义：'+x)
 print('指纹：'+before)
 if not a.apply:return
 if issues:raise SystemExit('存在歧义，拒绝 --apply。')
 if fingerprint(root)!=before:raise SystemExit('数据文件或文件清单已变化，拒绝写入。')
 backup=root.parent/('远期图测试-分期备份-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'));shutil.copytree(root,backup)
 originals={p:p.read_bytes() for p in changed}
 try:
  if fingerprint(root)!=before:raise RuntimeError('并发 fingerprint 变化，拒绝写入')
  for p,d in changed.items():p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 except Exception:
  for p,b in originals.items():p.write_bytes(b)
  raise
 print(f'已写入；备份：{backup}')
if __name__=='__main__':main()
