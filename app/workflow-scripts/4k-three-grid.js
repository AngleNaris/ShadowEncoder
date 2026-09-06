if (inputs.length !== 3) throw new Error('Please provide exactly 3 materials in list order.');

const duration = Math.max(0.1, ...inputs.map(input => input.duration > 0 ? input.duration : 10));
if (duration > 86400) throw new Error('Maximum output duration is 24 hours.');

// Three 1920x1080 cells: top-left, top-right, bottom-left; bottom-right stays black.
const filters = inputs.map((_, index) =>
  `[${index}:v]setpts=PTS-STARTPTS,fps=30,` +
  'scale=1920:1080:force_original_aspect_ratio=decrease,' +
  'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,' +
  `tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration}[v${index}]`
);
filters.push('[v0][v1][v2]xstack=inputs=3:layout=0_0|1920_0|0_1080:fill=black[out]');
return { filterComplex: filters.join(';'), duration };
