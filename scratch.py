from anipy_api.anime import Anime
from anipy_api.provider import get_provider
from anipy_api.provider import LanguageTypeEnum

provider = get_provider("animekai")
anime = Anime(provider, "8", "8", "Unknown")
eps = anime.get_episodes(lang=LanguageTypeEnum.SUB)
if eps:
    video = anime.get_video(episode=eps[0].number, lang=LanguageTypeEnum.SUB)
    print(dir(video))
    print(vars(video))
