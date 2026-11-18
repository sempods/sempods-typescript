# Pods & sharing

Interactive design reference for sempods/sempods-typescript#386. The UI uses German example labels. All Pod data and consent outcomes are simulated in memory. The Focus sign-in examples render the SDK component with a fixture runtime.

Unzip the archive, open a terminal in the extracted folder and run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [the prototype](http://127.0.0.1:8000/). Close the management dialog to see the scenario links, or go directly to an example.

- [Combined view](http://127.0.0.1:8000/?ansicht=gemeinsam)
- [Single-Pod selection](http://127.0.0.1:8000/?ansicht=einzeln)
- [Management with no connected Pod](http://127.0.0.1:8000/?ansicht=leer)
- [First sign-in](http://127.0.0.1:8000/?ansicht=start)
- [Sign-in with saved addresses](http://127.0.0.1:8000/?ansicht=abgemeldet)

Resize the window to try the mobile bottom sheet. “Connect another Pod” illustrates the entry point and navigation. Its production implementation should reuse the SDK chooser shown in the sign-in examples.
