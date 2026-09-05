<template>
  <div ref="rootElement" id="alteka" :class="{gradient : config.alteka.gradient}" :style="cssVars" >
    <div class="grid">
      <div class="gridQuadrant gridtopleft" :style="grid"></div>
      <div class="gridQuadrant gridtopright" :style="grid"></div>
      <div class="gridQuadrant gridbottomleft" :style="grid"></div>
      <div class="gridQuadrant" :style="grid"></div>
    </div>

    <div class="border">
      <div class="borderTop" :class="{borderAnimatedl2r : config.animated}"></div>
      <div class="borderBottom" :class="{borderAnimatedr2l : config.animated}"></div>
      <div class="borderLeft" :class="{borderAnimatedbtt : config.animated}"></div>
      <div class="borderRight" :class="{borderAnimatedttb : config.animated}"></div>
    </div>

    <div class="corners">
      <div class="cornerTopLeft" :style="{'border-color': this.config.alteka.fg}"></div>
      <div class="cornerTopRight" :style="{'border-color': this.config.alteka.fg}"></div>
      <div class="cornerBottomLeft" :style="{'border-color': this.config.alteka.fg}"></div>
      <div class="cornerBottomRight" :style="{'border-color': this.config.alteka.fg}"></div>
    </div>

    <div class="arrows">
      <div class="arrowTop" :style="{'border-bottom-color': this.config.alteka.fg}"></div>
      <div class="arrowRight" :style="{'border-left-color': this.config.alteka.fg}"></div>
      <div class="arrowBottom" :style="{'border-top-color': this.config.alteka.fg}"></div>
      <div class="arrowLeft" :style="{'border-right-color': this.config.alteka.fg}"></div>
    </div>

    <div ref="pillarLeft" id="pillarLeft" class="pillar">
      <swatch colour="black" ire="-7.5" :showText="false"></swatch>
      <swatch colour="black" ire="0" :showText="false"></swatch>
      <swatch colour="black" ire="10" :showText="false"></swatch>
      <swatch colour="black" ire="20" :showText="false"></swatch>
      <swatch colour="black" ire="30" :showText="false"></swatch>
      <swatch colour="black" ire="40" :showText="false"></swatch>
      <swatch colour="black" ire="50" :showText="false"></swatch>
      <swatch colour="black" ire="60" :showText="false"></swatch>
      <swatch colour="black" ire="70" :showText="false"></swatch>
      <swatch colour="black" ire="80" :showText="false"></swatch>
      <swatch colour="black" ire="90" :showText="false"></swatch>
      <swatch colour="black" ire="100" :showText="false"></swatch>
      <swatch colour="black" ire="109" :showText="false"></swatch>
    </div>

    <div ref="pillarRight" id="pillarRight" class="pillar">
      <div class="stripe-v-4"></div>
      <div class="stripe-v-2"></div>
      <div class="stripe-v-1"></div>
      <div class="stripe-h-1"></div>
      <div class="stripe-h-2"></div>
      <div class="stripe-h-4"></div>
    </div>

    <div class="cornerCircles">
      <svg viewBox="0 0 50 50">
        <defs>
          <clipPath id="clipSmallCircle">
            <circle cx="0" cy="0" r="25" />
          </clipPath>
          <linearGradient id="vAlphaB" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgb(0 0 0);stop-opacity:0" />
            <stop offset="100%" style="stop-color:rgb(0 0 0);stop-opacity:1" />
          </linearGradient>
        </defs>
      </svg>
      <div class="circleTopLeft">
        <svg viewBox="-25 -25 50 50" height="100%" width="100%" preserveAspectRatio="xMinYMin meet">
          <g clip-path="url(#clipSmallCircle)">
            <rect x="-25" y="-25" height="26" width="26" fill="rgb(0 0 0)" />
            <rect x="0" y="-25" height="26" width="25" fill="rgb(16 16 16)" />
            <rect x="-25" y="0" height="25" width="26" fill="rgb(16 16 16)" />
            <rect x="0" y="0" height="25" width="25" fill="rgb(0 0 0)" />
            <use href="#spinny-radar" fill="url('#vAlpha')"/>
            <circle cx="0" cy="0" r="25" stroke="white" stroke-width="1" fill="none" />
          </g>
        </svg>
      </div>
      <div class="circleTopRight">
        <svg viewBox="-25 -25 50 50" height="100%" width="100%" preserveAspectRatio="xMaxYMin meet">
          <g clip-path="url(#clipSmallCircle)">
            <rect x="-25" y="-25" height="26" width="26" fill="rgb(255 255 255)" />
            <rect x="0" y="-25" height="26" width="25" fill="rgb(234 234 234)" />
            <rect x="-25" y="0" height="25" width="26" fill="rgb(234 234 234)" />
            <rect x="0" y="0" height="25" width="25" fill="rgb(255 255 255)" />
            <use href="#spinny-radar" fill="url('#vAlphaB')" />
            <circle cx="0" cy="0" r="25" stroke="white" stroke-width="1" fill="none" />
          </g>
        </svg>
      </div>
      
      <div class="circleBottomLeft">
        <svg viewBox="-25 -25 50 50" height="100%" width="100%" preserveAspectRatio="xMinYMax meet">
          <g clip-path="url(#clipSmallCircle)">
            <path d='M0,0 L45,0 A45,45 0 0,1 22.5,38.97z' fill="rgb(0 180 180)" />
            <path d='M0,0 L22.5,38.97 A45,45 0 0,1 -22.5,38.97z' fill="rgb(180 0 180)" />
            <path d='M0,0 L-22.5,38.97 A45,45 0 0,1 -45,0z' fill="rgb(180 180 0)" />
            <path d='M0,0 L-45,0 A45,45 0 0,1 -22.5,-38.97z' fill="rgb(0 255 255)" />
            <path d='M0,0 L-22.5,-38.97 A45,45 0 0,1 22.5,-38.97z' fill="rgb(255 0 255)" />
            <path d='M0,0 L22.5,-38.97 A45,45 0 0,1 45,0z' fill="rgb(255 255 0)" />
            <use href="#spinny-radar" fill="url('#vAlphaB')"/>
            <circle cx="0" cy="0" r="25" stroke="white" stroke-width="1" fill="none" />
          </g>
        </svg>
      </div>
      <div class="circleBottomRight">
        <svg viewBox="-25 -25 50 50" height="100%" width="100%" preserveAspectRatio="xMaxYMax meet">
            <g clip-path="url(#clipSmallCircle)">
            <path d='M0,0 L45,0 A45,45 0 0,1 22.5,38.97z' fill="rgb(180 0 0)" />
            <path d='M0,0 L22.5,38.97 A45,45 0 0,1 -22.5,38.97z' fill="rgb(0 180 0)" />
            <path d='M0,0 L-22.5,38.97 A45,45 0 0,1 -45,0z' fill="rgb(0 0 180)" />
            <path d='M0,0 L-45,0 A45,45 0 0,1 -22.5,-38.97z' fill="rgb(235 0 0)" />
            <path d='M0,0 L-22.5,-38.97 A45,45 0 0,1 22.5,-38.97z' fill="rgb(0 235 0)" />
            <path d='M0,0 L22.5,-38.97 A45,45 0 0,1 45,0z' fill="rgb(0 0 235)" />
            <use href="#spinny-radar" fill="url('#vAlpha')"/>
            <circle cx="0" cy="0" r="25" stroke="white" stroke-width="1" fill="none" />
          </g>
        </svg>
      </div>
    </div>

    <div id="centerbox">
      <transition name="fade">
        <img v-if="config.alteka.showLogo" ref="customLogo" id="customLogo" :src="'./assets/icons/SVG/app_icon_lightmode@web.svg'" height="0" width="0" alt="DonWells Cue"/>      
      </transition>

      <svg viewBox="-50 -50 100 100" height="100%" width="100%">
        <defs>
          <clipPath id="clipCircle">
            <circle cx="0" cy="0" r="45" />
          </clipPath>
          <linearGradient id="hLuma" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color:rgb(16,16,16);stop-opacity:1" />
            <stop offset="100%" style="stop-color:rgb(235,235,235);stop-opacity:1" />
          </linearGradient>
          <linearGradient id="parade" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0" stop-color="rgb(235 0 0)" />
            <stop offset="0.333" stop-color="rgb(235 235 0)" />
            <stop offset="0.5" stop-color="rgb(0 235 0)" />
            <stop offset="0.666" stop-color="rgb(0 235 235)" />
            <stop offset="0.833" stop-color="rgb(0 0 235)" />
            <stop offset="1" stop-color="rgb(235 0 235)" />
          </linearGradient>
          <linearGradient id="vLuma" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgb(235 235 235);stop-opacity:1" />
            <stop offset="100%" style="stop-color:rgb(16 16 16);stop-opacity:1" />
          </linearGradient>
          <linearGradient id="vAlpha" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgb(235 235 235);stop-opacity:0" />
            <stop offset="100%" style="stop-color:rgb(235 235 235);stop-opacity:1" />
          </linearGradient>
        </defs>

        <g ref="clipMe" id="clip-me" clip-path="url('#clipCircle')">
          <transition name="fade">
            <svg v-if="!config.alteka.showLogo" viewBox="0 0 850.39 283.46" x="-45" y="-15" width="90" height="30" aria-label="DonWells Cue">
              <rect style="fill:#6ab42f;" width="850.39" height="283.46"/>
              <text x="425.195" y="128" text-anchor="middle" style="fill:#fff;font-family:Sansation,Helvetica,sans-serif;font-size:70px;font-weight:700;letter-spacing:2px;">DONWELLS CUE</text>
              <text x="425.195" y="193" text-anchor="middle" style="fill:#fff;font-family:Sansation,Helvetica,sans-serif;font-size:34px;letter-spacing:6px;">dwcue.com</text>
            </svg>
          </transition>
          <rect x="-45" y="-45" width="90" height="30.1" fill="url('#hLuma')" />
          <rect x="-45" y="15" width="90" height="30.1" fill="url('#parade')" />
          <rect x="-45" y="15" width="90" height="30.1" fill="url('#vLuma')" style="mix-blend-mode: multiply" />
          <transition name="fade">
            <g v-if="config.showInfo">
            <g v-if="config.alteka.showLogo" :fill="config.alteka.bg" fill-opacity="75%">
              <rect x="-45" y="11" width="90" height="4" />
              <rect x="-45" y="-15" width="90" height="7" />
            </g>
            <text x="0" y="-9.5" w="50" text-anchor="middle" font-size="5px" :style="{fill: text}">{{config.name}}</text>
            <text x="-40" y="14" w="50" text-anchor="start" font-size="3px" :style="{fill: text}">{{ info.network[info.networkIndex] }}</text>
            <text x="40" y="14" w="50" text-anchor="end" font-size="3px" :style="{fill: text}">{{info.cardSize}} - {{info.displayFrequency}}Hz</text>
            <text v-if="config.showClock" x="0" y="14" w="50" text-anchor="middle" font-size="3px" :style="{fill: text}">{{info.time}}</text>
          </g>
          </transition>
          <transition name="fade">
          <g v-if="config.animated" id="spinny-box">
            <animateTransform attributeName="transform" type="rotate" dur="4s" from="0" to="360" repeatCount="indefinite" />
            <path d='M0,0 L45,0 A45,45 0 0,1 44.83,3.92z' fill="url('#vAlpha')" />
          </g>
          </transition>
          <circle cx="0" cy="0" r="45" stroke="white" stroke-width="1" fill="none" />
        </g>
      </svg>
    </div>
  </div>
</template>

<script>
import Swatch from './Swatch.vue'
export default {
  name: "AltekaTestCard",
  components: { Swatch },
  props: {
    config: Object,
    info: Object,
    borderSize: Number
  },
  data: function() {
    return {
      resizeObserver: null
    }
  },
  watch: {
    'config.alteka': {
      handler: function() {
        this.$nextTick(this.measure)
      },
      deep: true
    },
    borderSize: function() {
      this.$nextTick(this.measure)
    }
  },
  computed: {
    text: function() {
      if (this.config.alteka.showLogo) {
        return this.config.alteka.textColour
      } else {
        return "#fff"
      }
    },
    grid: function() {
      var luma = this.toLuma(this.config.alteka.bg)
      if (luma > 127) {
        return {
          'outline': '2px solid #000',
          'background-image': `linear-gradient(to right, #444 1px, transparent 1px), linear-gradient(to bottom, #444 1px, transparent 1px)`
        }
      } else {
        return {
          'outline': '2px solid white',
          'background-image': `linear-gradient(to right, #bbb 1px, transparent 1px), linear-gradient(to bottom, #bbb 1px, transparent 1px)`
        }
      }
    },
    cssVars: function() {
      return {
        'background' : this.config.alteka.bg,
        '--border-size': this.borderSize + 'px'
      }
    }
  },
  methods: {
    toLuma: function(hex) {
      var c = hex.substring(1)
      var rgb = parseInt(c, 16)
      var r = (rgb >> 16) & 0xff
      var g = (rgb >>  8) & 0xff
      var b = (rgb >>  0) & 0xff
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    },
    handleResize: function({ width, height }) {
      // console.log('Alteka Kard - Handle Resize for ', width, height)
      let ratio = width/height
      
      let pillarLeft = this.$refs.pillarLeft
      let pillarRight = this.$refs.pillarRight
      let circle = this.$refs.clipMe
      let customLogo = this.$refs.customLogo
      if (!pillarLeft || !pillarRight || !circle || width <= 0 || height <= 0) return
      let circleWidth = circle.getBoundingClientRect().width

      if (customLogo) {
        customLogo.style.width = circleWidth + 'px'
        customLogo.style.height = (circle.getBoundingClientRect().height / 3) + 2 + 'px'
      }

      // New and improved pillar size and position algorithm

      let long = width // the long edge of the card
      let short = height // the short edge of the card
      let aspect = ratio // like ratio but doesn't care about orientation
let gridSize = this.borderSize * 2

      if (ratio < 1) {
        short = width
        long = height
        aspect = 1/ratio
      }
      // console.log(aspect)

      // core pillar size based on size and shape of card
      let pillarShort = Math.round((long / gridSize) * aspect * 0.04) * gridSize - 1;
      if (pillarShort < gridSize) pillarShort = gridSize; // minimum short edge of 50px
      let pillarLong = (Math.floor((short / (gridSize*2)) * 0.66)) * (gridSize*2) - 1;

      if (aspect < 1.4) pillarLong -= (gridSize*2) // avoid pillars being under the circles in cards that are nearly square

      if (pillarShort > (gridSize*6)) pillarShort = (gridSize*6); // limit short edge to 300px

      // gap is pixels from edge of circle to inside edge of pillar
      let gap = 0
      if (Math.round(pillarShort/gridSize) > 1) gap = gridSize
      if (Math.round(pillarShort/gridSize) > 2) gap = 2*gridSize
      if (gap == 0 && aspect > 1.8) gap = gridSize
      if (gap >= gridSize && circleWidth%gridSize < 15) gap -= gridSize

      // now apply the pillar size and gap to the pillar objects
      if (ratio >= 1) {
        pillarLeft.style.width = pillarShort + "px"
        pillarRight.style.width = pillarShort + "px"
        pillarLeft.style.height = pillarLong + "px"
        pillarRight.style.height = pillarLong + "px"
        pillarLeft.style.flexDirection = "column"
        pillarRight.style.flexDirection = "column"
        pillarLeft.style.bottom = '50%'
        pillarLeft.style.transform = 'none'
        pillarLeft.style.transform = 'translateY(calc(+50% + 0.5px))'
        pillarRight.style.top = 'calc(50% + 0.5px)'
        pillarRight.style.transform = 'translateY(-50%)'
        
        let left = (Math.ceil(circleWidth / 2 / gridSize) * gridSize + width / 2) + gap
        pillarRight.style.left = left + 1 + "px"
        pillarLeft.style.left = width - left - pillarShort + "px"
      } else {
        pillarLeft.style.width = pillarLong + "px"
        pillarRight.style.width = pillarLong + "px"
        pillarLeft.style.height = pillarShort + "px"
        pillarRight.style.height = pillarShort + "px"
        pillarLeft.style.flexDirection = "row"
        pillarRight.style.flexDirection = "row"
        pillarLeft.style.left = 'calc(50% + 0.5px)'
        pillarRight.style.left = 'calc(50% + 0.5px)'
        pillarLeft.style.transform = 'translateX(-50%)'
        pillarRight.style.transform = 'translateX(-50%)'

        let leftBottom = (height/2) + (Math.ceil(circleWidth / 2 / gridSize) * gridSize) + gap
        pillarLeft.style.bottom = leftBottom + 'px'
        pillarRight.style.top = leftBottom + 1 + 'px'
      }
    },
    measure: function() {
      const bounds = this.$refs.rootElement?.getBoundingClientRect()
      if (bounds) this.handleResize(bounds)
    }
  },
  mounted: function() {
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) this.handleResize(entry.contentRect)
    })
    this.resizeObserver.observe(this.$refs.rootElement)
    this.measure()
  },
  beforeUnmount: function() {
    this.resizeObserver?.disconnect()
  }
}
</script>

<style scoped>
#customLogo {
  position: absolute;
  z-index: -10;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  object-fit: cover;
  clip-path: circle(66.7%);
  background-color: #6ab42e;
}
.grid {
  height: 100%;
  width: 100%;
}
.gridQuadrant {
  height: 50%;
  width: 50%;
  outline: 2px solid white;
  outline-offset: -2px;
  float: left;
  background-size: calc(2*var(--border-size)) calc(2*var(--border-size));
  background-image: linear-gradient(to right, #666 1px, transparent 1px),
    linear-gradient(to bottom, #666 1px, transparent 1px);
}

.gridtopleft {
    background-position: bottom right;
  }
  .gridtopright {
    background-position: bottom left;
  }
  .gridbottomleft {
    background-position: top right;
  }
.gradient:before {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background-image: radial-gradient(circle, rgba(255,255,255,0.3) 50%, rgba(0,0,0,0.4) 100%);
  }

.border {
  position: absolute;
  height: 100%;
  width: 100%;
  top: 0px;
  left: 0px;
}
.border div {
  position: absolute;
  background-size: calc(var(--border-size)*4) calc(var(--border-size)*4);
  background-position: 50%;
}
.borderTop {
  background: black;
  background-image: linear-gradient(270deg, transparent 50%, currentColor 50%);
  height: var(--border-size);
  width: 100%;
  top: 0px;
}
.borderBottom {
  background: black;
  background-image: linear-gradient(90deg, transparent 50%, currentColor 50%);
  height: var(--border-size);
  bottom: 0px;
  width: 100%;
}
.borderLeft {
  left: 0;
  width: var(--border-size);
  height: 100%;
  background: black;
  background-image: linear-gradient(0deg, transparent 50%, currentColor 50%);
}
.borderRight {
  right: 0;
  width: var(--border-size);
  height: 100%;
  background: black;
  background-image: linear-gradient(180deg, transparent 50%, currentColor 50%);
}

.borderAnimatedl2r {
  animation: left-to-right 4s infinite;
  animation-timing-function: linear;
}
.borderAnimatedr2l {
  animation: right-to-left 4s infinite;
  animation-timing-function: linear;
}
.borderAnimatedbtt {
  animation: bottom-to-top 4s infinite;
  animation-timing-function: linear;
}
.borderAnimatedttb {
  animation: top-to-bottom 4s infinite;
  animation-timing-function: linear;
}
@keyframes left-to-right {
    0%       { background-position: 0%; }
    100%     { background-position: calc(var(--border-size)*4); }
}
@keyframes right-to-left {
    0%       { background-position: calc(var(--border-size)*4); }
    100%     { background-position: 0%; }
}
@keyframes top-to-bottom {
    0%       { background-position: 0 0%; }
    100%     { background-position: 0 calc(var(--border-size)*4); }
}
@keyframes bottom-to-top {
    0%       { background-position: 0 calc(var(--border-size)*4); }
    100%     { background-position: 0 0%; }
}

.corners {
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
}
.corners div {
  width: calc(var(--border-size)*2);
  height:  calc(var(--border-size)*2);
  position: absolute;
}
.cornerTopLeft {
  top: 0;
  left: 0;
  border-top:  var(--border-size) solid red;
  border-left: var(--border-size) solid red;
}
.cornerTopRight {
  top: 0;
  right: 0;
  border-top: var(--border-size) solid red;
  border-right: var(--border-size) solid red;
}
.cornerBottomLeft {
  bottom: 0;
  left: 0;
  border-bottom: var(--border-size) solid red;
  border-left: var(--border-size) solid red;
}
.cornerBottomRight {
  bottom: 0;
  right: 0;
  border-bottom: var(--border-size) solid red;
  border-right: var(--border-size) solid red;
}

.arrows {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 100%;
}
.arrows div {
  position: absolute;
  width: 0;
  height: 0;
}
.arrowTop {
  left: calc(50% - var(--border-size)*2);
  border-right: calc(var(--border-size)*2) solid transparent;
  border-bottom: calc(var(--border-size)*2) solid #6ab42e;
  border-left: calc(var(--border-size)*2) solid transparent;
}
.arrowBottom {
  left: calc(50% - var(--border-size)*2);
  bottom: 0;
  border-right: calc(var(--border-size)*2) solid transparent;
  border-top: calc(var(--border-size)*2) solid #6ab42e;
  border-left: calc(var(--border-size)*2) solid transparent;
}
.arrowLeft {
  top: calc(50% - var(--border-size)*2);
  border-top: calc(var(--border-size)*2) solid transparent;
  border-right: calc(var(--border-size)*2) solid #6ab42e;
  border-bottom: calc(var(--border-size)*2) solid transparent;
}
.arrowRight {
  top: calc(50% - var(--border-size)*2);
  right: 0;
  border-top: calc(var(--border-size)*2) solid transparent;
  border-left: calc(var(--border-size)*2) solid #6ab42e;
  border-bottom: calc(var(--border-size)*2) solid transparent;
}

.pillar {
  position: absolute;
  display: flex;
}
.pillar div {
  width: 100%;
  height: 100%;
  padding: 0;
}
.stripe-v-1 {
  background-image: repeating-linear-gradient(
    0deg,
    white,
    white 1px,
    black 1px,
    black
  );
  background-size: 2px 2px;
}
.stripe-v-2 {
  background-image: repeating-linear-gradient(
    0deg,
    white,
    white 2px,
    black 2px,
    black
  );
  background-size: 4px 4px;
}
.stripe-v-4 {
  background-image: repeating-linear-gradient(
    0deg,
    white,
    white 4px,
    black 4px,
    black
  );
  background-size: 8px 8px;
}
.stripe-h-1 {
  background-image: repeating-linear-gradient(
    90deg,
    white,
    white 1px,
    black 1px,
    black
  );
  background-size: 2px 2px;
}
.stripe-h-2 {
  background-image: repeating-linear-gradient(
    90deg,
    white,
    white 2px,
    black 2px,
    black
  );
  background-size: 4px 4px;
}
.stripe-h-4 {
  background-image: repeating-linear-gradient(
    90deg,
    white,
    white 4px,
    black 4px,
    black
  );
  background-size: 8px 8px;
}

.cornerCircles {
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
}
.cornerCircles div {
  width: 14%;
  height: 25%;
  position: absolute;
}

.circleTopLeft {
  top: calc(var(--border-size)*2);
  left: calc(var(--border-size)*2);
}
.circleTopRight {
  top: calc(var(--border-size)*2);
  right: calc(var(--border-size)*2);
}
.circleBottomLeft {
  bottom: calc(var(--border-size)*2);
  left: calc(var(--border-size)*2);
}
.circleBottomRight {
  bottom: calc(var(--border-size)*2);
  right: calc(var(--border-size)*2);
}


#alteka {
  background: #3d3d3d;
  height: 100%;
  width: 100%;
  color: white;
}

#centerbox {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  height: 66%;
  width: 66%;
  overflow: hidden;
}

.ramp {
  margin-top: 45%;
  height: 10%;
  width: 100%;
  background: linear-gradient(to right, black, white);
}

.gradient:before {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background-image: radial-gradient(
    circle,
    rgba(0, 0, 0, 0) 0%,
    rgba(0, 0, 0, 0.3) 100%
  );
}
</style>
