# Launch drafts

Nothing here has been posted. `LIVE_URL` stands for the deployed address; the site is not deployed yet.

## X thread

1. I made a web toy where window movement drives real fluid physics. Open a few browser windows, push them together, and the water pours from one into the next. [hero.mp4]

2. Each window publishes its viewport rectangle in screen coordinates over a BroadcastChannel. Together the rectangles are the world, so dragging a window moves a wall of the simulation.

3. There is one simulation, not one per window. A single visible window takes a Web Lock, becomes the leader, and runs a 2D MLS-MPM solver on WebGPU for all of them.

4. The other windows get the part of the field under them as a float16 crop, through a SharedArrayBuffer when the page is cross-origin isolated, otherwise copied over the channel. Each window renders its own view.

5. Close the leader and the next window takes the lock and resumes from a particle snapshot published every 100 ms. Close a window and its water rains into the others.

6. It is frontend only, MIT licensed, and rough in places: Chrome is the tested target. Try it at LIVE_URL. Source: https://github.com/Venkat-jaswanth/tidal

## Show HN

Title: Show HN: Tidal – water that pours between your browser windows

Body:

Tidal is a frontend-only web toy. You open several browser windows, push them together, and water pours from one into the next. Dragging a window sloshes the water in it, and closing a window rains its water into the others.

Every window publishes its viewport rectangle in screen coordinates over a BroadcastChannel. One visible window takes a Web Lock and runs a 2D MLS-MPM solver on WebGPU for all of them, using the window rectangles as walls. The other windows receive the field under them as a float16 crop and draw their own view.

What is rough: Chrome desktop is the tested target. Firefox and Safari are untested. Phone tilt has only been tried in emulation. The liquid is weakly compressible, and scripts cannot move popups across displays, so some effects depend on the platform.

Live: LIVE_URL
Source (MIT): https://github.com/Venkat-jaswanth/tidal

## Bluesky

I built a toy where moving browser windows drives real fluid physics. One WebGPU simulation, shared by every window, with each window's rectangle acting as a wall. Push two together and the water pours across. LIVE_URL https://github.com/Venkat-jaswanth/tidal
