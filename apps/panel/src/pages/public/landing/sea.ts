// The night sea under everything after the cover: a height field of sharp-crested waves, marched
// from a low camera, lit only by the sky and a moon off to the right. Black where nothing reflects.

const VERTEX = "attribute vec2 a;void main(){gl_Position=vec4(a,0,1);}";

const FRAGMENT = `
precision highp float;
uniform vec2 R; uniform float T; uniform float S;
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
// One wave and how it pulls the water sideways; summed in rotating directions, each finer and faster.
vec2 wdx(vec2 p,vec2 d,float f,float ph){float x=dot(d,p)*f+ph;float w=exp(sin(x)-1.);return vec2(w,-w*cos(x));}
float waves(vec2 p,int it){float sum=0.,ws=0.,fr=1.,tm=T*1.5,wt=1.,k=0.;
 for(int i=0;i<36;i++){if(i>=it)break;vec2 d=vec2(sin(k),cos(k));vec2 r=wdx(p,d,fr,tm);p+=d*r.y*wt*.38;sum+=r.x*wt;ws+=wt;wt*=.8;fr*=1.18;tm*=1.07;k+=1232.4;}
 return sum/ws;}
const float D=1.2;
vec3 MD=normalize(vec3(.28,.09,1.));
vec3 sky(vec3 d){float m=max(dot(d,MD),0.);float y=max(d.y,0.);
 vec3 c=vec3(.03,.06,.12)*exp(-y*3.)+vec3(.12,.2,.34)*exp(-y*14.)*.6+vec3(.3,.12,.25)*exp(-y*30.)*.25;
 c+=vec3(.95,.97,1.)*(smoothstep(.9996,.99985,m)*4.+pow(m,500.)*1.2+pow(m,30.)*.1);
 return c;}
vec3 sea(vec2 fc){
 vec2 uv=(fc-.5*R)/R.y;
 vec3 ro=vec3(0.,1.5,T*.8+S*5.);
 vec3 rd=normalize(vec3(uv.x,uv.y-.22,1.));
 if(rd.y>=0.){vec3 c=sky(rd);c+=vec3(step(.9985,h21(floor(fc))))*.4*smoothstep(0.,.25,rd.y);return c;}
 float t=-ro.y/rd.y,te=(-D-ro.y)/rd.y;vec3 pos=ro+rd*t;
 for(int i=0;i<64;i++){float h=waves(pos.xz*.45,12)*D-D;if(h+.01>pos.y)break;t+=pos.y-h;pos=ro+rd*t;if(t>te)break;}
 float e=.01;vec2 q=pos.xz*.45;float h0=waves(q,30)*D;
 vec3 n=normalize(vec3(-(waves(q+vec2(e,0),30)*D-h0)/e*.45,1.,-(waves(q+vec2(0,e),30)*D-h0)/e*.45));
 n=normalize(mix(n,vec3(0,1,0),.75*min(1.,sqrt(t*.01)*1.1)));
 vec3 rf=reflect(rd,n);rf.y=abs(rf.y);
 float fr=.04+.96*pow(1.-max(0.,dot(-n,rd)),5.);
 vec3 c=fr*sky(rf)*1.6+vec3(.01,.03,.05)*pow(max(pos.y+D,0.)/D,3.)*.9;
 c=mix(c,sky(normalize(vec3(rd.x,.001,rd.z))),1.-exp(-t*.01));
 return c;
}
void main(){
 vec2 fc=gl_FragCoord.xy;vec3 c=1.-exp(-sea(fc)*1.8);
 vec2 v=fc/R-.5;c*=1.-dot(v,v)*.5;
 gl_FragColor=vec4(c,1.);
}`;

export interface Sea {
  /** `seconds` moves the waves; `scroll` (in screen heights) moves the camera forward. */
  render(seconds: number, scroll: number): void;
  resize(): void;
}

/** `null` without WebGL; the page is then plain black under the sections. */
export function mountSea(canvas: HTMLCanvasElement, scale: number): Sea | null {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false });
  if (!gl) return null;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type) as WebGLShader;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const p = gl.createProgram() as WebGLProgram;
  gl.attachShader(p, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL, not a React hook
  gl.useProgram(p);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(p, "R");
  const uT = gl.getUniformLocation(p, "T");
  const uS = gl.getUniformLocation(p, "S");
  const resize = () => {
    canvas.width = Math.round(canvas.clientWidth * scale);
    canvas.height = Math.round(canvas.clientHeight * scale);
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  return {
    resize,
    render(seconds, scroll) {
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.uniform1f(uT, seconds);
      gl.uniform1f(uS, scroll);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
