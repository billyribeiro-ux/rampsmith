# Evaluation images: licences and attribution

Every image in `images/` is openly licensed. The machine-readable record is `manifest.json`;
this file repeats it for people. Photos were taken from sample data bundled in Python packages
on PyPI, whose own documentation states each licence; the remaining images were drawn for this
repository by `make_images.py` and are dedicated to the public domain under CC0 1.0. All
images were resized to a 448 px long edge and saved as JPEG (ADR-217).

| Image | Licence | Author | Licence stated in | Copy obtained from |
| --- | --- | --- | --- | --- |
| `espresso-cup.jpg` | CC0-1.0 | Rachel Michetti (courtesy of Pikolo Espresso Bar) | scikit-image data documentation, skimage.data.coffee: "No copyright restrictions. CC0 by the photographer" | scikit-image 0.25.2 wheel from PyPI, skimage/data/coffee.png |
| `tabby-cat.jpg` | CC0-1.0 | Stefan van der Walt | scikit-image data documentation, skimage.data.chelsea: "No copyright restrictions. CC0 by the photographer" | scikit-image 0.25.2 wheel from PyPI, skimage/data/chelsea.png |
| `astronaut-portrait.jpg` | LicenseRef-Public-Domain | NASA | scikit-image data documentation, skimage.data.astronaut: NASA Great Images database, "No known copyright restrictions, released into the public domain" | scikit-image 0.25.2 wheel from PyPI, skimage/data/astronaut.png |
| `rocket-launch.jpg` | LicenseRef-Public-Domain | SpaceX | scikit-image data documentation, skimage.data.rocket: SpaceX photos "released in the public domain" | scikit-image 0.25.2 wheel from PyPI, skimage/data/rocket.jpg |
| `wall-clock-blurred.jpg` | LicenseRef-Public-Domain | Stefan van der Walt | scikit-image data documentation, skimage.data.clock: "Released into the public domain by the photographer" | scikit-image 0.25.2 wheel from PyPI, skimage/data/clock_motion.png |
| `photographer-tripod.jpg` | CC0-1.0 | Lav Varshney | scikit-image data documentation, skimage.data.camera: "No copyright restrictions. CC0 by the photographer" | scikit-image 0.25.2 wheel from PyPI, skimage/data/camera.png |
| `horse-silhouette.jpg` | CC0-1.0 | Andreas Preuss (marauder), openclipart | scikit-image data documentation, skimage.data.horse: "No copyright restrictions. CC0 given by owner" | scikit-image 0.25.2 wheel from PyPI, skimage/data/horse.png |
| `brick-wall.jpg` | CC0-1.0 | CC0Textures (Bricks25), transformed by scikit-image | scikit-image data documentation, skimage.data.brick: "licensed under the Creative Commons CC0 License" | scikit-image 0.25.2 wheel from PyPI, skimage/data/brick.png |
| `grass-texture.jpg` | CC0-1.0 | linolafett (DeviantArt), cropped by scikit-image | scikit-image data documentation, skimage.data.grass: "licensed under the Creative Commons CC0 License" | scikit-image 0.25.2 wheel from PyPI, skimage/data/grass.png |
| `garden-gravel.jpg` | CC0-1.0 | CC0Textures (Gravel04), cropped by scikit-image | scikit-image data documentation, skimage.data.gravel: "licensed under the Creative Commons CC0 License" | scikit-image 0.25.2 wheel from PyPI, skimage/data/gravel.png |
| `deep-field.jpg` | LicenseRef-Public-Domain | NASA, ESA (Hubble eXtreme Deep Field) | scikit-image data documentation, skimage.data.hubble_deep_field: NASA images "may be freely used in the public domain" | scikit-image 0.25.2 wheel from PyPI, skimage/data/hubble_deep_field.jpg |
| `pagoda-lake.jpg` | CC-BY-2.0 | danielbuechele (Flickr) | https://www.flickr.com/photos/danielbuechele/6061409035/ via scikit-learn sklearn/datasets/images/README.txt | scikit-learn 1.7.2 wheel from PyPI, sklearn/datasets/images/china.jpg |
| `orange-dahlia.jpg` | CC-BY-2.0 | vultilion (Flickr) | https://www.flickr.com/photos/vultilion/6056698931/ via scikit-learn sklearn/datasets/images/README.txt | scikit-learn 1.7.2 wheel from PyPI, sklearn/datasets/images/flower.jpg |
| `size-chart.jpg` | CC0-1.0 | Rampsmith contributors (WS-12 stream) | Drawn by eval/dataset/make_images.py with Pillow; text set in DejaVu Sans. | Generated in this repository |
| `tea-box.jpg` | CC0-1.0 | Rampsmith contributors (WS-12 stream) | Drawn by eval/dataset/make_images.py with Pillow; text set in DejaVu Sans. | Generated in this repository |
| `sock-pack-injection.jpg` | CC0-1.0 | Rampsmith contributors (WS-12 stream) | Drawn by eval/dataset/make_images.py with Pillow; text set in DejaVu Sans. | Generated in this repository |
| `striped-tshirt.jpg` | CC0-1.0 | Rampsmith contributors (WS-12 stream) | Drawn by eval/dataset/make_images.py with Pillow; text set in DejaVu Sans. | Generated in this repository |
| `linen-swatches.jpg` | CC0-1.0 | Rampsmith contributors (WS-12 stream) | Drawn by eval/dataset/make_images.py with Pillow; text set in DejaVu Sans. | Generated in this repository |
| `sage-mug.jpg` | CC0-1.0 | Rampsmith contributors (WS-12 stream) | Drawn by eval/dataset/make_images.py with Pillow; text set in DejaVu Sans. | Generated in this repository |
| `free-shipping-banner.jpg` | CC0-1.0 | Rampsmith contributors (WS-12 stream) | Drawn by eval/dataset/make_images.py with Pillow; text set in DejaVu Sans. | Generated in this repository |

CC BY 2.0: https://creativecommons.org/licenses/by/2.0/. CC0 1.0:
https://creativecommons.org/publicdomain/zero/1.0/. Text in the drawn images is set in DejaVu
Sans, whose licence permits this use.

`make_images.py` rebuilds every file from the packages above:
`python3 -I make_images.py <dir with the extracted sample files> <output dir>`, where the input
directory holds `coffee.png`, `chelsea.png`, `astronaut.png`, `rocket.jpg`, `clock_motion.png`,
`camera.png`, `horse.png`, `brick.png`, `grass.png`, `gravel.png` and `hubble_deep_field.jpg`
from `skimage/data/` in the scikit-image 0.25.2 wheel, and `china.jpg` and `flower.jpg` from
`sklearn/datasets/images/` in the scikit-learn 1.7.2 wheel.
